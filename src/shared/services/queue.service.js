const handlers = [];

export function registerJobHandler(name, fn) {
  handlers.push({ name, fn });
}

export async function enqueueJob(name, data) {
  const handler = handlers.find((h) => h.name === name);
  if (handler) {
    setImmediate(() => handler.fn(data).catch((err) => console.error(`[QUEUE] ${name} failed:`, err.message)));
    return { queued: true, mode: 'inline' };
  }
  console.log(`[QUEUE] job=${name}`, data);
  return { queued: true, mode: 'log' };
}

registerJobHandler('notification', async (data) => {
  const { sendEmail } = await import('./email.service.js');
  if (data.email) await sendEmail(data.email);
});

registerJobHandler('report', async (data) => {
  console.log('[QUEUE] report job', data.type);
});
