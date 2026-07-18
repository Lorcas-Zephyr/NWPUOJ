const nodemailer = require('nodemailer');

function mailConfiguration() {
  const port = Number(process.env.SYZOJ_WEB_SMTP_PORT || 465);
  const user = String(process.env.SYZOJ_WEB_SMTP_USER || '').trim();
  const password = String(process.env.SYZOJ_WEB_SMTP_PASS || '');
  if (!user || !password) throw new Error('SMTP credentials are not configured.');
  return {
    host: String(process.env.SYZOJ_WEB_SMTP_HOST || '').trim(),
    port,
    secure: port === 465,
    auth: { user, pass: password }
  };
}

async function sendSiteMail(message) {
  const configuration = mailConfiguration();
  const fromName = String(process.env.SYZOJ_WEB_SMTP_FROM_NAME || syzoj.config.title || 'Online Judge');
  const transporter = nodemailer.createTransport(configuration);
  return transporter.sendMail({
    from: `"${fromName.replace(/["\r\n]/g, '')}" <${configuration.auth.user}>`,
    to: message.to,
    subject: message.subject,
    html: message.html
  });
}

module.exports = { sendSiteMail };
