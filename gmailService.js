// gmailService.js
const { google } = require('googleapis');

function makeBody(to, from, subject, htmlMessage, textMessage = null) {
  // Create multipart email with both HTML and text versions
  const boundary = 'boundary_' + Math.random().toString(36).substr(2, 9);
  
  let emailBody = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    textMessage || htmlMessage.replace(/<[^>]*>/g, ''), // Strip HTML tags for text version
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlMessage,
    '',
    `--${boundary}--`
  ].join('\n');

  return Buffer.from(emailBody)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Alternative simpler version if you only want HTML
function makeHtmlBody(to, from, subject, htmlMessage) {
  const str = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlMessage,
  ].join('\n');

  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendTestEmail(to, subject, message, textMessage = null) {
  // Get credentials from environment variables
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  const refresh_token = process.env.GOOGLE_REFRESH_TOKEN;

  if (!client_id || !client_secret || !redirect_uri || !refresh_token) {
    throw new Error('Missing Google OAuth environment variables');
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);
    
  // Use refresh token to get access token
  oAuth2Client.setCredentials({
    refresh_token: refresh_token
  });

  // Refresh the access token if needed
  const { credentials } = await oAuth2Client.refreshAccessToken();
  oAuth2Client.setCredentials(credentials);

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  
  // Use the HTML-capable makeBody function
  const raw = makeBody(to, process.env.GMAIL_FROM || 'me', subject, message, textMessage);

  try {
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
      },
    });
    return result.data;
  } catch (error) {
    console.error('Error sending email:', error);
    throw new Error('Failed to send email');
  }
}

// Alternative function for HTML-only emails (simpler)
async function sendHtmlEmail(to, subject, htmlMessage) {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect_uri = process.env.GOOGLE_REDIRECT_URI;
  const refresh_token = process.env.GOOGLE_REFRESH_TOKEN;

  if (!client_id || !client_secret || !redirect_uri || !refresh_token) {
    throw new Error('Missing Google OAuth environment variables');
  }

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);
  oAuth2Client.setCredentials({ refresh_token: refresh_token });

  const { credentials } = await oAuth2Client.refreshAccessToken();
  oAuth2Client.setCredentials(credentials);

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  const raw = makeHtmlBody(to, process.env.GMAIL_FROM || 'me', subject, htmlMessage);

  try {
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    return result.data;
  } catch (error) {
    console.error('Error sending email:', error);
    throw new Error('Failed to send email');
  }
}

module.exports = { sendTestEmail, sendHtmlEmail };