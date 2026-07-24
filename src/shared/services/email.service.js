import { env } from '../../config/env.js';

export async function sendEmail({ to, subject, text, html }) {
  if (!to) return { sent: false, reason: 'no_recipient' };

  if (env.smtpHost && env.smtpUser) {
    try {
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpSecure,
        auth: { user: env.smtpUser, pass: env.smtpPass },
      });
      await transport.sendMail({
        from: env.smtpFrom || env.smtpUser,
        to,
        subject,
        text,
        html: html || text,
      });
      return { sent: true, channel: 'smtp' };
    } catch (err) {
      console.error('[EMAIL] SMTP failed:', err.message);
      return { sent: false, reason: err.message };
    }
  }

  if (env.nodeEnv !== 'test') {
    console.log(`[EMAIL] to=${to} subject=${subject}`);
  }
  return { sent: true, channel: 'log' };
}
