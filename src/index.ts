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


async function getYesterdayPST(): Promise<{ start: string; end: string }> {
	try {
		const currentPST = new Date()
		currentPST.setTime(currentPST.getTime() + (-8 * 60 * 60 * 1000));

		console.log('Current PST from API:', currentPST.toISOString());
		console.log('Current PST local:', currentPST.toString());

		// Get yesterday by subtracting one day from the current date
		const yesterdayPST = new Date(currentPST);
		yesterdayPST.setUTCDate(currentPST.getUTCDate() - 1);
		console.log('Yesterday PST:', yesterdayPST.toISOString());
		console.log('Yesterday PST local:', yesterdayPST.toString());

		// Extract year, month, and day from yesterdayPST
		const year = yesterdayPST.getUTCFullYear();
		const month = yesterdayPST.getUTCMonth();
		const day = yesterdayPST.getUTCDate();

		// Create start of yesterday in PST (00:00:00 PST = 08:00:00 UTC)
		const startPST = new Date(Date.UTC(year, month, day, 8, 0, 0, 0));

		// Create end of yesterday in PST (23:59:59.999 PST = 07:59:59.999 UTC next day)
		const endPST = new Date(Date.UTC(year, month, day + 1, 7, 59, 59, 999));

		console.log('Time calculations:');
		console.log('Year/Month/Day (UTC):', year, month + 1, day);
		console.log('Start PST (UTC):', startPST.toISOString());
		console.log('Start PST (local):', startPST.toString());
		console.log('End PST (UTC):', endPST.toISOString());
		console.log('End PST (local):', endPST.toString());

		// Additional validation
		const startInPST = new Date(startPST.toISOString());
		startInPST.setHours(startInPST.getHours() - 8); // Convert to PST for validation
		console.log('Start time in PST should be midnight:', startInPST.toString());

		const endInPST = new Date(endPST.toISOString());
		endInPST.setHours(endInPST.getHours() - 8); // Convert to PST for validation
		console.log('End time in PST should be 23:59:59:', endInPST.toString());

		return {
			start: startPST.toISOString(),
			end: endPST.toISOString()
		};
	} catch (error) {
		console.error('Error getting PST time:', error);
		throw error;
	}
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
	console.log(`Fetching orders for ${store.domain} with query: ${query}`);
	if (cursor) {
		console.log(`Using cursor: ${cursor}`);
	}

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
	console.log(`Fetching Shopify orders for ${store.domain}`);
	console.log(`Date range: ${dateRange.start} to ${dateRange.end}`);
	const query = `created_at:>='${dateRange.start}' AND created_at:<='${dateRange.end}' AND risk_level:LOW OR risk_level:MEDIUM OR risk_level:non`;
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

		console.log(`Page ${pageCount} summary for ${store.domain}:`);
		console.log(`- Total orders so far: ${allOrders.length}`);
		console.log(`- Has next page: ${hasNextPage}`);
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
	console.log(`Final results for ${store.domain}:`);
	console.log(`- Total unique orders: ${allOrders.length}`);
	console.log(`- Total amount: ${totalAmount}`);

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
					`📦 Orders: ${metrics.orderCount}\n`
					// `💰 Total: $${metrics.totalAmount.toFixed(2)}`
				)
				.join('\n\n') +
			`\n\n📈 Summary:\n` +
			`Total Orders: ${totalOrders}\n`
		// `Total Amount: $${totalAmount.toFixed(2)}`
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
			const dateRange = await getYesterdayPST();
			const date = new Date(dateRange.start).toLocaleDateString("en-US", {
				timeZone: "America/Los_Angeles",
				year: 'numeric',
				month: '2-digit',
				day: '2-digit'
			});
			console.log(`Running report for PDT date: ${date}`);
			console.log('Date range:', {
				startPDT: new Date(dateRange.start).toLocaleString("en-US", {
					timeZone: "America/Los_Angeles"
				}),
				endPDT: new Date(dateRange.end).toLocaleString("en-US", {
					timeZone: "America/Los_Angeles"
				}),
				startUTC: dateRange.start,
				endUTC: dateRange.end
			});
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
			console.log('storeMetrics', storeMetrics)
			const zoho_url = `${env.ZOHO_CLIQ_API_ENDPOINT}?zapikey=${env.ZOHO_CLIQ_WEBHOOK_TOKEN}&bot_unique_name=${env.ZOHO_CLIQ_BOTNAME}`
			await sendToCliq(zoho_url, storeMetrics, date);
		} catch (error) {
			console.error('Worker execution failed:', error);
		}
	},
};