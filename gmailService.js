// gmailService.js
const { google } = require('googleapis');

function makeBody(to, from, subject, message) {
  const str = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    '',
    message,
  ].join('\n');

  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendTestEmail(to, subject, message) {
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
  const raw = makeBody(to, 'me', subject, message);

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

module.exports = { sendTestEmail };