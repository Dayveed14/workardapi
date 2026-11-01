// Throw this anywhere in a service to send a clean error to the client.
// Example: throw new AppError(404, 'Employee not found');
export default class AppError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors; // optional { fieldName: 'message' } for forms
  }
}
