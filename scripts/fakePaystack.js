// ============================================================
// A FAKE Paystack server for tests only.
// Answers like the real API (https://paystack.com/docs/transfers/)
// so the payroll payout flow can be tested without real money.
// It remembers every transfer reference it received, so the tests can
// prove a retry re-uses the same reference (no double payment).
// ============================================================
import express from 'express';

export function startFakePaystack({ validKey }) {
  const app = express();
  app.use(express.json());

  const state = { transfers: [], recipients: 0 };

  app.use((req, res, next) => {
    if (req.get('authorization') !== `Bearer ${validKey}`) {
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

  const server = app.listen(0);
  return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}
