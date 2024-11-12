interface ShopifyStore {
	type: 'shopify';
	domain: string;
	accessToken: string;
}

interface ShopifyOrder {
	created_at: string;
	total_price: string;
}interface MagentoStore {
	type: 'magento';
	domain: string;
	accessToken: string;
}

type Store = ShopifyStore | MagentoStore;


interface StoreMetrics {
	orderCount: number;
	totalAmount: number;
}

interface Environment {
	SHOPIFY_DOMAINS: string; // Comma-separated list of domains
	SHOPIFY_ACCESS_TOKENS: string; // Comma-separated list of access tokens
	MAGENTO_DOMAINS: string;
	MAGENTO_ACCESS_TOKENS: string;
	ZOHO_CLIQ_API_ENDPOINT: string;
	ZOHO_CLIQ_WEBHOOK_TOKEN: string;
	ZOHO_CLIQ_BOTNAME: string;
}

const ORDERS_QUERY = `query getOrders($query: String!, $cursor: String) {
	orders(first: 250, query: $query, after: $cursor) {
	  edges {
		node {
		  id
		  totalPriceSet {
			shopMoney {
			  amount
			  currencyCode
			}
		  }
		}
	  }
	  pageInfo {
		hasNextPage
		endCursor
	  }
	}
  }`;


function getYesterdayDate(): { start: string; end: string } {
	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);
	yesterday.setHours(0, 0, 0, 0);

	const end = new Date(yesterday);
	end.setHours(23, 59, 59, 999);

	return {
		start: yesterday.toISOString(),
		end: end.toISOString()
	};
}

function getStoresFromEnv(env: Environment): Store[] {
	const stores: Store[] = [];
	if (env.SHOPIFY_DOMAINS && env.SHOPIFY_ACCESS_TOKENS) {
		const shopifyDomains = env.SHOPIFY_DOMAINS.split(',').map(d => d.trim());
		const shopifyTokens = env.SHOPIFY_ACCESS_TOKENS.split(',').map(t => t.trim());

		if (shopifyDomains.length !== shopifyTokens.length) {
			throw new Error('Number of domains and access tokens must match');
		}

		shopifyDomains.forEach((domain, index) => {
			stores.push({
				type: 'shopify',
				domain,
				accessToken: shopifyTokens[index],
			});
		});
	}
	if (env.MAGENTO_DOMAINS && env.MAGENTO_ACCESS_TOKENS) {
		const magentoDomains = [env.MAGENTO_DOMAINS];
		const magentoTokens = [env.MAGENTO_ACCESS_TOKENS];

		if (magentoDomains.length !== magentoTokens.length) {
			throw new Error('Number of Magento domains and access tokens must match');
		}

		magentoDomains.forEach((domain, index) => {
			stores.push({
				type: 'magento',
				domain,
				accessToken: magentoTokens[index],
			});
		});
	}

	return stores;
}

async function fetchShopifyOrdersPage(store: ShopifyStore, query: string, cursor?: string): Promise<any> {
	const response = await fetch(`https://${store.domain}.myshopify.com/admin/api/2024-01/graphql.json`, {
		method: 'POST',
		headers: {
			'X-Shopify-Access-Token': store.accessToken,
			'Content-Type': 'application/json',
		},

		body: JSON.stringify({
			query: ORDERS_QUERY,
			variables: {
				query,
				cursor
			}
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch orders from ${store.domain}: ${response.statusText}`);
	}

	const data: any = await response.json();
	if (data.errors) {
		throw new Error(`GraphQL errors for ${store.domain}: ${JSON.stringify(data.errors)}`);
	}

	return data.data.orders;
}

async function fetchMagentoOrdersPage(store: MagentoStore, dateRange: { start: string; end: string }, page: number): Promise<any> {
	const formatDate = (date: string, isEndDate: boolean) => {
		const d = new Date(date);
		const year = d.getUTCFullYear();
		const month = String(d.getUTCMonth() + 1).padStart(2, '0');
		const day = String(d.getUTCDate()).padStart(2, '0');
		const time = isEndDate ? '23:59:59' : '00:00:00';
		return `${year}-${month}-${day} ${time}`;
	};

	const startDate = formatDate(dateRange.start, false);
	const endDate = formatDate(dateRange.start, true);

	console.log(`Fetching orders for ${store.domain} between ${startDate} and ${endDate}`);

	const searchCriteria = {
		'searchCriteria[filterGroups][0][filters][0][field]': 'created_at',
		'searchCriteria[filterGroups][0][filters][0][value]': startDate,
		'searchCriteria[filterGroups][0][filters][0][condition_type]': 'gteq',
		'searchCriteria[filterGroups][1][filters][0][field]': 'created_at',
		'searchCriteria[filterGroups][1][filters][0][value]': endDate,
		'searchCriteria[filterGroups][1][filters][0][condition_type]': 'lteq',
		'searchCriteria[sortOrders][0][field]': 'created_at',
		'searchCriteria[sortOrders][0][direction]': 'DESC',
		'searchCriteria[currentPage]': page.toString(),
		'searchCriteria[pageSize]': '100'
	};

	const queryString = Object.entries(searchCriteria)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join('&');

	const url = `https://${store.domain}/rest/V1/orders?${queryString}`;
	console.log(`Fetching Magento orders from: ${url}`);

	const response = await fetch(url, {
		headers: {
			'Authorization': `Bearer ${store.accessToken}`,
			'Content-Type': 'application/json',
		},
	});

	if (!response.ok) {
		const responseText = await response.text();
		throw new Error(`Failed to fetch Magento orders from ${store.domain}: ${response.statusText}. Response: ${responseText}`);
	}

	const data: any = await response.json();

	// Log the first and last order dates to verify date filtering
	if (data.items && data.items.length > 0) {
		console.log(`First order date: ${data.items[0].created_at}`);
		console.log(`Last order date: ${data.items[data.items.length - 1].created_at}`);
	}

	return data;
}

async function fetchMagentoOrders(store: MagentoStore, dateRange: { start: string; end: string }): Promise<StoreMetrics> {
	let page = 1;
	let totalPages = 1;
	let allOrders: any[] = [];

	try {
		// Fetch first page to get total pages
		const firstPage = await fetchMagentoOrdersPage(store, dateRange, page);
		allOrders = firstPage.items || [];

		// Calculate total pages
		const totalItems = firstPage.total_count || 0;
		totalPages = Math.ceil(totalItems / 100);

		console.log(`Total ${totalItems} orders, ${totalPages} pages for ${store.domain}`);

		// Fetch remaining pages
		for (page = 2; page <= totalPages; page++) {
			console.log(`Fetching page ${page}/${totalPages} for ${store.domain}`);
			const pageData = await fetchMagentoOrdersPage(store, dateRange, page);
			if (pageData.items) {
				allOrders = [...allOrders, ...pageData.items];
			}

			// Add delay between requests
			if (page < totalPages) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}

		const totalAmount = allOrders.reduce((sum: number, order: any) => {
			const grandTotal = parseFloat(order.grand_total || '0');
			return sum + (isNaN(grandTotal) ? 0 : grandTotal);
		}, 0);

		return {
			orderCount: allOrders.length,
			totalAmount: totalAmount
		};
	} catch (error) {
		console.error(`Error fetching Magento orders for ${store.domain}:`, error);
		throw error;
	}
}

async function fetchShopifyOrders(store: ShopifyStore, dateRange: { start: string; end: string }): Promise<StoreMetrics> {
	const query = `created_at:>='${dateRange.start}' AND created_at:<='${dateRange.end}'`;
	let hasNextPage = true;
	let cursor: string | undefined;
	let allOrders: any[] = [];
	let pageCount = 0;
	const MAX_PAGES = 20;

	while (hasNextPage && pageCount < MAX_PAGES) {
		const pageData = await fetchShopifyOrdersPage(store, query, cursor);
		allOrders = [...allOrders, ...pageData.edges];

		hasNextPage = pageData.pageInfo.hasNextPage;
		cursor = pageData.pageInfo.endCursor;
		pageCount++;

		console.log(`Fetched page ${pageCount} for ${store.domain}. Orders so far: ${allOrders.length}`);

		// Add a small delay between requests to respect rate limits
		if (hasNextPage) {
			await new Promise(resolve => setTimeout(resolve, 500));
		}
	}

	if (pageCount >= MAX_PAGES) {
		console.warn(`Reached maximum page limit for ${store.domain}. Some orders might be missing.`);
	}
	const totalAmount = allOrders.reduce(
		(sum: number, edge: any) => sum + parseFloat(edge.node.totalPriceSet.shopMoney.amount),
		0
	);

	return {
		orderCount: allOrders.length,
		totalAmount: totalAmount
	};
}


async function sendToCliq(webhookUrl: string, storeData: { [key: string]: StoreMetrics }, date: string) {
	const domainName: any = {
		'eliquid-com': "eliquid.com",
		"MistHub": "misthub.com",
		"ejuices-co": "ejuices.co",
		"ejuices": "ejuices.com",
		"yamivapor": "yamivapor",
		"deals-305": "alohasunvapor.com",
		"ca2bbf": "rodman9k.com"
	}
	const totalOrders = Object.values(storeData)
		.reduce((sum, metrics) => sum + metrics.orderCount, 0);
	const totalAmount = Object.values(storeData)
		.reduce((sum, metrics) => sum + metrics.totalAmount, 0);

	const message = {
		text: `📊 Sales Report for ${date}\n\n` +
			Object.entries(storeData)
				.map(([domain, metrics]) =>
					`${domainName[domain] || domain}:\n` +
					`📦 Orders: ${metrics.orderCount}\n` +
					`💰 Total: $${metrics.totalAmount.toFixed(2)}`
				)
				.join('\n\n') +
			`\n\n📈 Summary:\n` +
			`Total Orders: ${totalOrders}\n` +
			`Total Amount: $${totalAmount.toFixed(2)}`
	};

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(message),
	});

	if (!response.ok) {
		throw new Error(`Failed to send message to Cliq: ${response.statusText}`);
	}
}

export default {
	async scheduled(event: ScheduledEvent, env: Environment, ctx: ExecutionContext) {
		try {
			const dateRange = getYesterdayDate();
			const date = dateRange.start.split('T')[0];
			const stores = getStoresFromEnv(env);
			const storeMetrics: { [key: string]: StoreMetrics } = {};

			// Fetch orders from all stores in parallel
			await Promise.all(
				stores.map(async (store) => {
					try {
						storeMetrics[store.domain] = store.type === 'shopify'
							? await fetchShopifyOrders(store, dateRange)
							: await fetchMagentoOrders(store, dateRange);
					} catch (error) {
						console.error(`Error fetching orders for ${store.domain}:`, error);
						storeMetrics[store.domain] = { orderCount: 0, totalAmount: 0 };
					}
				})
			);

			const zoho_url = `${env.ZOHO_CLIQ_API_ENDPOINT}?zapikey=${env.ZOHO_CLIQ_WEBHOOK_TOKEN}&bot_unique_name=${env.ZOHO_CLIQ_BOTNAME}`
			await sendToCliq(zoho_url, storeMetrics, date);
		} catch (error) {
			console.error('Worker execution failed:', error);
		}
	},
};