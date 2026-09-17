// ============================================================================
// M23: EMAIL TEMPLATES — verifikasi email, reset password, test SMTP
//
// Desain: teks inti di PLAIN TEXT (anti spam-filter + selalu terbaca) +
// HTML sederhana gelap ala dashboard (konsisten brand BaseForge).
// Token tidak pernah ditempel mentah di HTML — selalu di dalam <a href>
// (plain text pun sama, satu baris link terpisah utk copy manual).
// ============================================================================

const BRAND = 'BaseForge';

function htmlWrap(title: string, bodyHtml: string, ctaUrl: string, ctaLabel: string): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Inter,system-ui,-apple-system,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="color:#fafafa;font-size:18px;font-weight:600;margin-bottom:28px;">
      wekanz<span style="color:#9e9e9e;">BaseForge</span>
    </div>
    <div style="background:#121212;border:1px solid #292929;border-radius:10px;padding:28px;">
      <h1 style="color:#ededed;font-size:18px;font-weight:600;margin:0 0 12px 0;">${title}</h1>
      ${bodyHtml}
      <a href="${ctaUrl}"
         style="display:inline-block;margin:20px 0 8px 0;background:#fafafa;color:#0a0a0a;
                text-decoration:none;font-weight:500;font-size:14px;
                padding:10px 20px;border-radius:8px;">
        ${ctaLabel}
      </a>
      <p style="color:#9e9e9e;font-size:11px;line-height:1.6;margin:16px 0 0 0;
                word-break:break-all;">
        Atau buka tautan ini di browser Anda:<br>
        <span style="color:#ededed;">${ctaUrl}</span>
      </p>
      <p style="color:#9e9e9e;font-size:11px;margin:20px 0 0 0;border-top:1px solid #292929;padding-top:16px;">
        Jika Anda tidak merasa melakukan permintaan ini, abaikan email —
        tautan akan kedaluwarsa otomatis dan aman dihapus.
      </p>
    </div>
    <p style="color:#6b6b6b;font-size:11px;margin-top:20px;">
      Email otomatis dari ${BRAND}. Jangan balas email ini.
    </p>
  </div>
</body>
</html>`;
}

export interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

// ─── Verifikasi email ─────────────────────────────────────────────────────────

export function verificationEmail(projectName: string, verifyUrl: string): EmailTemplate {
  return {
    subject: `Verify your email — ${projectName} (${BRAND})`,
    text: [
      `Welcome to ${projectName}!`,
      ``,
      `Verify your email address by opening the link below:`,
      ``,
      verifyUrl,
      ``,
      `The link expires in 24 hours and can only be used once.`,
      `If you did not create an account, you can safely ignore this email.`,
    ].join('\n'),
    html: htmlWrap(
      'Verify your email',
      `<p style="color:#ededed;font-size:14px;line-height:1.6;margin:0;">
        Welcome to <strong style="color:#fafafa;">${escapeHtml(projectName)}</strong>!
        Confirm that this email address belongs to you to activate your account.
      </p>`,
      verifyUrl,
      'Verify Email'
    ),
  };
}

// ─── Reset password ───────────────────────────────────────────────────────────

export function passwordResetEmail(projectName: string, resetUrl: string): EmailTemplate {
  return {
    subject: `Reset your password — ${projectName} (${BRAND})`,
    text: [
      `Password reset requested for your ${projectName} account.`,
      ``,
      `Set a new password by opening the link below:`,
      ``,
      resetUrl,
      ``,
      `The link expires in 1 hour and can only be used once.`,
      `After resetting, you will be signed out from all devices.`,
      `If you did not request this, ignore this email — your password stays unchanged.`,
    ].join('\n'),
    html: htmlWrap(
      'Reset your password',
      `<p style="color:#ededed;font-size:14px;line-height:1.6;margin:0;">
        We received a request to reset the password of your
        <strong style="color:#fafafa;">${escapeHtml(projectName)}</strong> account.
        Click the button below to choose a new password.
      </p>`,
      resetUrl,
      'Reset Password'
    ),
  };
}

// ─── Test SMTP (admin) ────────────────────────────────────────────────────────

export function testEmail(to: string): EmailTemplate {
  return {
    subject: `${BRAND} test email — configuration works`,
    text: [
      `This is a test email from ${BRAND}.`,
      ``,
      `If you are reading this, the SMTP configuration is working correctly.`,
      `Recipient: ${to}`,
    ].join('\n'),
    html: htmlWrap(
      'SMTP configuration works',
      `<p style="color:#ededed;font-size:14px;line-height:1.6;margin:0;">
        This is a test email from ${BRAND}, sent to
        <strong style="color:#fafafa;">${escapeHtml(to)}</strong>.
        If you are reading this, your SMTP configuration is working correctly.
      </p>`,
      'https://github.com/DeffaldoFarel/WekanzBaseForge',
      'Open Documentation'
    ),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
