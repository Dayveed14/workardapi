// Checks req.body (or req.query) against a zod schema.
// On failure → 422 with { errors: { field: 'message' } } so forms can highlight fields.
export const validate =
  (schema, source = 'body') =>
  (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const errors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (field && !errors[field]) errors[field] = issue.message;
      }
      return res.status(422).json({ message: 'Please check the highlighted fields', errors });
    }
    if (source === 'body') req.body = result.data;
    else req.validatedQuery = result.data;
    next();
  };
