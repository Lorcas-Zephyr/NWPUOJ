'use strict';

function api() { return syzoj.utils.apiV2; }

app.post('/api/v2/auth/register', async (req, res) => {
  const service = syzoj.utils.registrationIdentityV2;
  const body = req.body || {};
  try {
    if (String(body.password || '') !== String(body.confirm_password || '')) {
      const error = new Error('两次输入的密码不一致。');
      error.statusCode = 422;
      throw error;
    }
    const data = await service.validateAccount(body);
    const user = await service.createAccount(data);
    await syzoj.utils.establishAuthenticatedSession(req, user.id);
    syzoj.utils.clearLegacyLoginCookie(req, res);
    let sent = true;
    try {
      await syzoj.utils.sendEmailVerification(req, user);
    } catch (mailError) {
      sent = false;
      syzoj.log('[registration-v2] verification email failed: ' + (mailError.stack || mailError));
    }
    return api().send(res, {
      authenticated: true,
      user: {
        id: Number(user.id),
        username: user.username
      },
      verification_sent: sent,
      redirect_url: `/email/verification-pending?sent=${sent ? '1' : '0'}`
    }, 201);
  } catch (error) {
    const registrationCode = typeof error === 'number' ? error : error && error.registrationCode;
    const status = Number(error && error.statusCode) || ([2008, 2009, 2014].includes(Number(registrationCode)) ? 409 : 422);
    const message = service && service.registrationErrorText ? service.registrationErrorText(error) : error.message || '注册失败。';
    return api().fail(res, status, status === 409 ? 'REGISTRATION_FAILED' : 'VALIDATION_FAILED', message);
  }
});
