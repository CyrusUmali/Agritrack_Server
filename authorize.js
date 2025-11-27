const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const open = require('open').default;

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];
const CREDENTIALS_PATH = 'credentials.json';
const TOKEN_PATH = 'token.json';

async function authorize() {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  const credentials = JSON.parse(content);

  const { client_secret, client_id, redirect_uris } = credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // 🔥 THIS LINE IS THE FIX
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',   // <--- Required to get a new refresh token
    scope: SCOPES,
  });

  console.log('Authorize this app by visiting this URL:', authUrl);
  await open(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const code = await new Promise(resolve =>
    rl.question('Enter the code here: ', resolve)
  );
  rl.close();

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

  console.log('Token saved to', TOKEN_PATH);
  console.log('Your refresh token:');
  console.log(tokens.refresh_token);
}

authorize().catch(console.error);
