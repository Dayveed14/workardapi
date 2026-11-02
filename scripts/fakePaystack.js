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
  const state = { transfers: [], recipients: 0, transactions: {} };

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
    tx.status = req.query.cancel ? 'abandoned' : 'success';
    res.redirect(`${tx.callback_url}?reference=${req.params.reference}&trxref=${req.params.reference}`);
  });

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
    const { reference, amount, email, callback_url: callbackUrl } = req.body;
    state.transactions[reference] = { amount, email, callback_url: callbackUrl, status: 'ongoing' };
    res.json({
      status: true,
      data: { authorization_url: `${baseUrl()}/checkout/${reference}`, access_code: `ac_${reference}`, reference },
    });
  });
  app.get('/transaction/verify/:reference', (req, res) => {
    const tx = state.transactions[req.params.reference];
    if (!tx) return res.status(400).json({ status: false, message: 'Transaction reference not found' });
    res.json({ status: true, data: { status: tx.status, amount: tx.amount, currency: 'NGN', reference: req.params.reference } });
  });

  const server = app.listen(0);
  const baseUrl = () => `http://127.0.0.1:${server.address().port}`;
  return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}
