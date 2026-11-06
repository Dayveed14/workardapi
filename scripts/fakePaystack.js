// ============================================================
// A FAKE Paystack server for tests only.
// Answers like the real API (https://paystack.com/docs/transfers/)
// so the payroll payout flow can be tested without real money.
// It remembers every transfer reference it received, so the tests can
// prove a retry re-uses the same reference (no double payment).
// ============================================================
import express from 'express';

export function startFakePaystack({ validKey, billingKey }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // transactions: reference → { amount, email, callback_url, status }
  const state = { transfers: [], recipients: 0, transactions: {}, plans: {}, subscriptions: [], customers: {}, counter: 0 };
  // Codes are unique per run (like real Paystack codes), so old test data never matches
  const run = Math.random().toString(36).slice(2, 7);
  const next = () => `${run}${(state.counter += 1)}`;

  // One Paystack customer per email
  const customerFor = (email) => {
    if (!state.customers[email]) {
      const n = next();
      state.customers[email] = { id: Number(String(Date.now()).slice(-6) + state.counter), customer_code: `CUS_test${n}`, email };
    }
    return state.customers[email];
  };
  const addSubscription = ({ customer, planCode, authorizationCode, startDate }) => {
    const n = next();
    const sub = {
      subscription_code: `SUB_test${n}`,
      email_token: `tok_test${n}`,
      status: 'active',
      plan: { plan_code: planCode },
      customer,
      authorization_code: authorizationCode,
      start_date: startDate || null,
    };
    state.subscriptions.push(sub);
    return sub;
  };

  // ---- A pretend checkout page (no API key — it's the page the customer sees) ----
  app.get('/checkout/:reference', (req, res) => {
    const tx = state.transactions[req.params.reference];
    if (!tx) return res.status(404).send('Unknown payment');
    res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
      <h1>Fake Paystack</h1><p>Pay ₦${(tx.amount / 100).toLocaleString()} for ${tx.email}</p>
      <form method="post" action="/checkout/${req.params.reference}"><button id="pay" type="submit">Pay now</button></form>
      <form method="post" action="/checkout/${req.params.reference}?cancel=1"><button id="cancel" type="submit">Cancel</button></form>
    </body></html>`);
  });
  app.post('/checkout/:reference', (req, res) => {
    const tx = state.transactions[req.params.reference];
    if (!tx) return res.status(404).send('Unknown payment');
    if (req.query.cancel) tx.status = 'abandoned';
    else pay(req.params.reference);
    res.redirect(`${tx.callback_url}?reference=${req.params.reference}&trxref=${req.params.reference}`);
  });

  // The customer pays (tests call this directly instead of clicking the fake page)
  function pay(reference) {
    const tx = state.transactions[reference];
    tx.status = 'success';
    tx.customer = customerFor(tx.email);
    tx.authorization = { authorization_code: `AUTH_test${next()}`, reusable: true };
    // Paying with a plan subscribes the card, like the real Paystack
    if (tx.plan) addSubscription({ customer: tx.customer, planCode: tx.plan, authorizationCode: tx.authorization.authorization_code });
    return tx;
  }

  // Paystack charges a subscription again (an automatic renewal). Returns the webhook body to send.
  function renew(subscriptionCode) {
    const sub = state.subscriptions.find((s) => s.subscription_code === subscriptionCode);
    const reference = `renewal_${next()}`;
    const amount = state.plans[sub.plan.plan_code].amount;
    state.transactions[reference] = { amount, email: sub.customer.email, status: 'success', customer: sub.customer };
    return { event: 'charge.success', data: { reference, amount, currency: 'NGN', status: 'success', customer: sub.customer, plan: sub.plan } };
  }

  const keys = [validKey, billingKey].filter(Boolean);
  app.use((req, res, next) => {
    if (!keys.some((k) => req.get('authorization') === `Bearer ${k}`)) {
      return res.status(401).json({ status: false, message: 'Invalid key' });
    }
    next();
  });

  app.get('/bank', (req, res) =>
    res.json({ status: true, data: [{ name: 'Access Bank', code: '044' }, { name: 'GTBank', code: '058' }, { name: 'UBA', code: '033' }] })
  );

  app.get('/bank/resolve', (req, res) =>
    res.json({ status: true, data: { account_number: req.query.account_number, account_name: 'TEST ACCOUNT HOLDER' } })
  );

  app.post('/transferrecipient', (req, res) => {
    state.recipients += 1;
    res.json({ status: true, data: { recipient_code: `RCP_test${state.recipients}`, details: req.body } });
  });

  app.post('/transfer/bulk', (req, res) => {
    const data = req.body.transfers.map((t, i) => {
      state.transfers.push(t);
      return { reference: t.reference, recipient: t.recipient, amount: t.amount, transfer_code: `TRF_${state.transfers.length}_${i}`, status: 'received' };
    });
    res.json({ status: true, message: `${data.length} transfers queued.`, data });
  });

  // ---- Accepting payments (Workard's subscription billing) ----
  app.post('/transaction/initialize', (req, res) => {
    const { reference, email, callback_url: callbackUrl, plan } = req.body;
    // With a plan, Paystack charges the plan's amount
    const amount = plan ? state.plans[plan]?.amount : req.body.amount;
    if (plan && !state.plans[plan]) return res.status(400).json({ status: false, message: 'Plan not found' });
    state.transactions[reference] = { amount, email, callback_url: callbackUrl, status: 'ongoing', plan: plan || null };
    res.json({
      status: true,
      data: { authorization_url: `${baseUrl()}/checkout/${reference}`, access_code: `ac_${reference}`, reference },
    });
  });
  app.get('/transaction/verify/:reference', (req, res) => {
    const tx = state.transactions[req.params.reference];
    if (!tx) return res.status(400).json({ status: false, message: 'Transaction reference not found' });
    res.json({
      status: true,
      data: { status: tx.status, amount: tx.amount, currency: 'NGN', reference: req.params.reference, customer: tx.customer, authorization: tx.authorization },
    });
  });

  // ---- Subscriptions ----
  app.post('/plan', (req, res) => {
    const code = `PLN_test${next()}`;
    state.plans[code] = { amount: req.body.amount, interval: req.body.interval, name: req.body.name };
    res.json({ status: true, data: { plan_code: code, ...state.plans[code] } });
  });
  app.get('/subscription', (req, res) => {
    const customerId = Number(req.query.customer);
    res.json({ status: true, data: state.subscriptions.filter((s) => s.customer.id === customerId) });
  });
  app.post('/subscription', (req, res) => {
    const customer = Object.values(state.customers).find((c) => c.customer_code === req.body.customer);
    if (!customer || !state.plans[req.body.plan]) return res.status(400).json({ status: false, message: 'Customer or plan not found' });
    const sub = addSubscription({ customer, planCode: req.body.plan, authorizationCode: req.body.authorization, startDate: req.body.start_date });
    res.json({ status: true, data: sub });
  });
  app.post('/subscription/disable', (req, res) => {
    const sub = state.subscriptions.find((s) => s.subscription_code === req.body.code && s.email_token === req.body.token);
    if (!sub) return res.status(400).json({ status: false, message: 'Subscription not found' });
    sub.status = 'disabled';
    res.json({ status: true, message: 'Subscription disabled successfully' });
  });
  app.get('/subscription/:code/manage/link', (req, res) =>
    res.json({ status: true, data: { link: `${baseUrl()}/manage/${req.params.code}` } })
  );

  const server = app.listen(0);
  const baseUrl = () => `http://127.0.0.1:${server.address().port}`;
  return { server, state, pay, renew, url: `http://127.0.0.1:${server.address().port}` };
}
