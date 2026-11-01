// Wraps an async controller so any thrown error goes to the error handler
// (saves writing try/catch in every controller).
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export default asyncHandler;
