export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ERP Factory API',
    version: '1.0.0',
    description: 'Textile Manufacturing ERP REST API',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      factoryHeader: { type: 'apiKey', in: 'header', name: 'X-Factory-Id' },
    },
  },
  security: [{ bearerAuth: [], factoryHeader: [] }],
  paths: {
    '/auth/login': { post: { summary: 'Login', tags: ['Auth'] } },
    '/auth/refresh': { post: { summary: 'Refresh access token', tags: ['Auth'] } },
    '/users/me': { get: { summary: 'Current user', tags: ['Users'] } },
    '/designs': { get: { summary: 'List designs', tags: ['Design'] }, post: { summary: 'Create design', tags: ['Design'] } },
    '/production-orders': { get: { summary: 'List production orders', tags: ['Production'] } },
    '/machines': { get: { summary: 'List machines', tags: ['Production'] } },
    '/reports/factory': { get: { summary: 'Factory dashboard', tags: ['Reports'] } },
    '/settings/general': { get: { summary: 'General settings', tags: ['Settings'] } },
    '/health/ready': { get: { summary: 'Readiness check', tags: ['System'] } },
  },
};
