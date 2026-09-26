export { SupportDomainError, publicSupportFailureMessage } from './errors.js';
export type { SupportErrorCode } from './errors.js';

export {
  createSupportTicket,
  getOwnSupportTicket,
  listOwnSupportTickets,
  postOwnSupportMessage,
} from './tickets.js';

export { requestAccountDeletion } from './deletion-request.js';
