/**
 * AdminAuthModule marker — controllers/guards are registered on AppModule so they
 * share DATABASE_POOL / API_CONFIG / REDIS_CLIENT providers (NestJS pattern used by
 * all Phase 3–12 API surfaces).
 */
export { AdminAuthController } from './admin-auth.controller.js';
export { AdminSessionGuard } from './admin-session.guard.js';
