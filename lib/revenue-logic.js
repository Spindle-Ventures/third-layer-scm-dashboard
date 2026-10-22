// dashboard/lib/revenue-logic.js
//
// Pure, framework-free business logic for the Revenue tab: 6-month inventory projection,
// component feasibility checks for a draft PO, product-mix revenue/unit metrics, and urgency
// ranking. No DOM, no Supabase client, no reference to window/document/global dashboard state --
// every input is an explicit argument. This is what makes the module unit-testable with 100%
// coverage (see test/revenue-logic.test.js) independent of a browser or a live database.
//
// index.html loads this as an ES module and exposes it as `window.RevenueLogic`, which the rest
// of the (non-module, classic-script) dashboard code calls into. Keep this file free of any
// DOM/Supabase/global-state coupling -- that boundary is the whole point.

/**
 * Computes one product's monthly demand in UNITS (not inventory level) across a set of months,
 * summing both channels -- the same direct_units formula as demand_engine.py
 * (channel_revenue * revenue_pct / ASP), without bundle expansion. Shared by computeProjection
 * (finished-good EOM inventory) and the Components tab (component consumption, via qty_per_unit).
 *
 * @param {object} args
 * @param {{product_id:string}} args.product
 * @param {string[]} args.months
 * @param {Record<string, {shopify?:number, amazon?:number}>} args.channelData
 * @param {object} args.mixData - [channel][product_id][month] -> {revenue_pct, avg_selling_price}
 * @returns {number[]} demand units, one entry per month, in the same order as `months`
 */
export function computeMonthlyDemandUnits({ product, months, channelData, mixData }) {
  return (months || []).map(m => {
    let demand = 0;
    ['shopify', 'amazon'].forEach(ch => {
      const mix = mixData?.[ch]?.[product.product_id]?.[m];
      const chanRev = channelData?.[m]?.[ch];
      if (mix && chanRev && mix.avg_selling_price) demand += (chanRev * mix.revenue_pct) / mix.avg_selling_price;
    });
    return demand;
  });
}

/**
 * Projects each product's end-of-month (EOM) inventory across a rolling set of months, given a
 * revenue forecast and product-mix assumptions, the same direct_units formula as
 * demand_engine.py's channel_revenue * revenue_pct / ASP (no bundle expansion -- a deliberate
 * simplification for this dashboard preview).
 *
 * @param {object} args
 * @param {Array<{product_id:string, sku_code:string, qty_on_hand:number}>} args.products
 * @param {string[]} args.months - e.g. ['2026-11', '2026-12', ...]
 * @param {Record<string, {shopify?:number, amazon?:number}>} args.channelData - forecast revenue by month/channel
 * @param {{shopify: Record<string, Record<string, {revenue_pct:number, avg_selling_price:number}>>, amazon: Record<string, Record<string, {revenue_pct:number, avg_selling_price:number}>>}} args.mixData - [channel][product_id][month] -> mix
 * @param {Record<string, Record<string, number>>} args.realReceipts - [sku_code][month] -> confirmed incoming qty (real open orders)
 * @param {Array<{product_id:string, eta_month:string, qty:number}>} [args.draftPOs] - hypothetical scenario POs
 * @returns {Record<string, number[]>} sku_code -> [eom_month0, eom_month1, ...]
 */
export function computeProjection({ products, months, channelData, mixData, realReceipts, draftPOs }) {
  const draftReceiptsByProductMonth = {};
  (draftPOs || []).forEach(po => {
    const m = po.eta_month.slice(0, 7);
    if (!draftReceiptsByProductMonth[po.product_id]) draftReceiptsByProductMonth[po.product_id] = {};
    draftReceiptsByProductMonth[po.product_id][m] = (draftReceiptsByProductMonth[po.product_id][m] || 0) + po.qty;
  });

  const out = {};
  (products || []).forEach(p => {
    let eom = p.qty_on_hand || 0;
    const series = [];
    const demandByMonth = computeMonthlyDemandUnits({ product: p, months, channelData, mixData });
    (months || []).forEach((m, i) => {
      const real = (realReceipts?.[p.sku_code] || {})[m] || 0;
      const draft = (draftReceiptsByProductMonth[p.product_id] || {})[m] || 0;
      eom = eom - demandByMonth[i] + real + draft;
      series.push(eom);
    });
    out[p.sku_code] = series;
  });
  return out;
}

/**
 * Checks whether componentry on hand + in-flight is enough to support a hypothetical finished-
 * good PO of the given quantity, per spec's net-need formula (net_need = gross_need - (QOH +
 * in_flight)), assuming a 1:1 component-per-unit ratio unless component_qoh.qty_per_unit says
 * otherwise. Never returns a "blocking" verdict -- callers decide what to do with a shortage
 * (per Alex's explicit choice, 2026-10-22: warn, never block).
 *
 * @param {Array<{product_sku:string, component_name:string, qty_per_unit?:number, qty_on_hand?:number, qty_in_flight?:number}>} componentQohRows
 * @param {string} productSku
 * @param {number} qty
 * @returns {Array<{component_name:string, required:number, available:number, short:number}>}
 */
export function checkComponentFeasibility(componentQohRows, productSku, qty) {
  const comps = (componentQohRows || []).filter(c => c.product_sku === productSku);
  return comps.map(c => {
    const required = qty * (c.qty_per_unit || 1);
    const available = (c.qty_on_hand || 0) + (c.qty_in_flight || 0);
    const short = required - available;
    return { component_name: c.component_name, required, available, short: short > 0 ? short : 0 };
  });
}

/**
 * Aggregate revenue/units/latest-% for one product on one channel across a set of months --
 * the sort metric basis for the Revenue tab's mix tables.
 *
 * @param {object} args
 * @param {string} args.channel
 * @param {{product_id:string}} args.product
 * @param {string[]} args.months
 * @param {object} args.draftMix - [channel][product_id][month] -> {revenue_pct, avg_selling_price}
 * @param {object} args.draftChannel - [month][channel] -> revenue
 * @returns {{revenue:number, units:number, pct:number}}
 */
export function productMixMetrics({ channel, product, months, draftMix, draftChannel }) {
  let revenue = 0, units = 0, pctLatest = 0;
  (months || []).forEach(m => {
    const mix = draftMix?.[channel]?.[product.product_id]?.[m];
    const chanRev = draftChannel?.[m]?.[channel];
    if (mix && chanRev != null) {
      revenue += chanRev * mix.revenue_pct;
      if (mix.avg_selling_price) units += (chanRev * mix.revenue_pct) / mix.avg_selling_price;
      pctLatest = mix.revenue_pct;
    }
  });
  return { revenue, units, pct: pctLatest };
}

/**
 * Generic sort for a list of {item, metrics} pairs by a named metric key or by name, ascending
 * or descending, with a stable tie-break fallback. Used by the Revenue tab's mix-table sort
 * controls and the Inventory Outlook table's urgency-first ordering.
 *
 * @param {Array<{item:any, metrics:Record<string, number>}>} entries
 * @param {{key:string, dir:'asc'|'desc', nameOf:(item:any)=>string, fallbackRank:(item:any)=>number}} opts
 * @returns {Array<any>} the `item`s, sorted
 */
export function sortByMetric(entries, { key, dir, nameOf, fallbackRank }) {
  const sign = dir === 'desc' ? -1 : 1;
  const sorted = (entries || []).slice().sort((a, b) => {
    let diff;
    if (key === 'name') diff = nameOf(a.item).localeCompare(nameOf(b.item)) * sign;
    else diff = ((a.metrics[key] || 0) - (b.metrics[key] || 0)) * sign;
    return diff || (fallbackRank(a.item) - fallbackRank(b.item));
  });
  return sorted.map(e => e.item);
}

/**
 * Calculates the last-responsible "place by" date for a PO: the latest date it can be placed and
 * still land by the given ETA, given a vendor's lead time. Pure date arithmetic, calendar days
 * (matches po_recommendations.py's `deadline = EOM(shortfall_month) - lead_days` convention --
 * no business-day adjustment).
 *
 * @param {string} etaDateIso - 'YYYY-MM-DD' (or 'YYYY-MM' is also accepted, treated as the 1st)
 * @param {number} leadDays
 * @returns {string} 'YYYY-MM-DD'
 */
export function computePlaceByDate(etaDateIso, leadDays) {
  const iso = etaDateIso.length === 7 ? `${etaDateIso}-01` : etaDateIso;
  const [y, m, d] = iso.split('-').map(Number);
  const eta = new Date(Date.UTC(y, m - 1, d));
  eta.setUTCDate(eta.getUTCDate() - (leadDays || 0));
  return eta.toISOString().slice(0, 10);
}

/**
 * Maps an agent_recommendations urgency string to a sort rank (lower = more urgent). Products
 * with no open recommendation (undefined/null) sort last.
 *
 * @param {string|undefined|null} urgency - 'CRITICAL' | 'WARNING' | 'WATCH' | undefined
 * @returns {number}
 */
export function urgencyRank(urgency) {
  const ranks = { CRITICAL: 0, WARNING: 1, WATCH: 2 };
  return ranks[urgency] ?? 3;
}

/**
 * Walks a starting quantity forward against a month-by-month consumption series and returns the
 * index of the first month where it would go negative (i.e. run out), or null if it never does
 * within the given horizon. Used by the Components tab to turn "QOH + in-flight" and a root
 * product's projected monthly demand into a simple runout estimate per component.
 *
 * @param {number} startingQty
 * @param {number[]} monthlyConsumption - units consumed each month, same order/length as months
 * @returns {number|null} 0-based month index of runout, or null if it lasts the whole horizon
 */
export function computeComponentRunout(startingQty, monthlyConsumption) {
  let remaining = startingQty || 0;
  for (let i = 0; i < (monthlyConsumption || []).length; i++) {
    remaining -= monthlyConsumption[i];
    if (remaining < 0) return i;
  }
  return null;
}

/**
 * Turns a runout month index into a simple three-tier ordering status, per Alex's explicit choice
 * (2026-10-22: "simple status flag... based on whether it'll cover upcoming production needs"),
 * using calendar-month-as-30-days arithmetic -- intentionally approximate, not a full
 * expand_to_component_pos()-style exact-date netting.
 *
 * - 'ORDER_NOW': will run out before a freshly-placed order could land (runout <= lead time).
 * - 'ORDER_SOON': will run out shortly after an order could land (within one more contact-cadence
 *   window past the lead time) -- time to start the conversation, not yet overdue.
 * - 'OK': comfortable runway beyond lead time + cadence, or never runs out in the horizon.
 *
 * @param {object} args
 * @param {number|null} args.runOutMonthIndex - from computeComponentRunout
 * @param {number} args.leadDays
 * @param {number} [args.cadenceDays]
 * @returns {'OK'|'ORDER_SOON'|'ORDER_NOW'}
 */
export function componentOrderStatus({ runOutMonthIndex, leadDays, cadenceDays }) {
  if (runOutMonthIndex == null) return 'OK';
  const daysUntilRunout = runOutMonthIndex * 30;
  if (daysUntilRunout <= (leadDays || 0)) return 'ORDER_NOW';
  if (daysUntilRunout <= (leadDays || 0) + (cadenceDays || 0)) return 'ORDER_SOON';
  return 'OK';
}

/**
 * Sort rank for componentOrderStatus (lower = more urgent). An unrecognized status sorts last,
 * same convention as urgencyRank.
 *
 * @param {string} status
 * @returns {number}
 */
export function componentStatusRank(status) {
  const ranks = { ORDER_NOW: 0, ORDER_SOON: 1, OK: 2 };
  return ranks[status] ?? 3;
}
