import 'dotenv/config';
import express, { Request, Response } from 'express';
import NodeCache from 'node-cache';
import session from 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    sessionID: string;
  }
}

const app = express();

const PORT = 3000;

const refreshTokenStore: Record<string, string> = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
  throw new Error('Missing CLIENT_ID or CLIENT_SECRET environment variable.');
}

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  All the following values must match configuration settings in your app.
//  They will be used to build the OAuth URL, which users visit to begin
//  installing. If they don't match your app's configuration, users will
//  see an error page.

// Replace the following with the values from your app auth config,
// or set them as environment variables before running.
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Scopes for this app will default to `crm.objects.contacts.read`
// To request others, set the SCOPE environment variable instead
const DEFAULT_SCOPES = ['crm.objects.contacts.read'];
let scopes: string;

if (process.env.SCOPE) {
  scopes = process.env.SCOPE.split(/ |, ?|%20/).join(' ');
} else {
  scopes = DEFAULT_SCOPES.join(' ');
}

// On successful install, users will be redirected to /oauth-callback
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;

//===========================================================================//

// Use a session to keep track of client ID
app.use(
  session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true,
  })
);

//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user
// to when they choose to install the app
const authUrl =
  'https://app.hubspot.com/oauth/authorize' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
  `&scope=${encodeURIComponent(scopes)}` + // scopes being requested by the app
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page

// Redirect the user from the installation page to
// the authorization URL
app.get('/install', (req, res) => {
  console.log('');
  console.log('=== Initiating OAuth 2.0 flow with HubSpot ===');
  console.log('');
  console.log("===> Step 1: Redirecting user to your app's OAuth URL");
  res.redirect(authUrl);
  console.log('===> Step 2: User is being prompted for consent by HubSpot');
});

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed
app.get('/oauth-callback', async (req, res) => {
  console.log('===> Step 3: Handling the request sent by the server');

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log('       > Received an authorization token');

    const authCodeProof = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code as string,
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log(
      '===> Step 4: Exchanging authorization code for an access token and refresh token'
    );
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      return res.redirect(`/error?msg=${token.message}`);
    }

    // Once the tokens have been retrieved, use them to make a query
    // to the HubSpot API
    res.redirect(`/`);
  }
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

async function exchangeForTokens(
  userId: string,
  exchangeProof: Record<string, string>
): Promise<{ access_token: string; refresh_token: string; message?: string }> {
  try {
    const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(exchangeProof).toString(),
    });

    if (!response.ok) {
      const errorBody = await response.json();
      console.error(
        `       > Error exchanging ${exchangeProof.grant_type} for access token`
      );
      return errorBody;
    }

    // Usually, this token data should be persisted in a database and associated with
    // a user identity.
    const tokens = await response.json();
    refreshTokenStore[userId] = tokens.refresh_token;
    accessTokenCache.set(
      userId,
      tokens.access_token,
      Math.round(tokens.expires_in * 0.75)
    );

    console.log('       > Received an access token and refresh token');
    return tokens;
  } catch (e) {
    console.error(
      `       > Error exchanging ${exchangeProof.grant_type} for access token`
    );
    throw e;
  }
}

function refreshAccessToken(
  userId: string
): Promise<{ access_token: string; refresh_token: string; message?: string }> {
  const refreshTokenProof = {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshTokenStore[userId],
  };
  return exchangeForTokens(userId, refreshTokenProof);
}

async function getAccessToken(userId: string): Promise<string> {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log('Refreshing expired access token');
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId) as string;
}

function isAuthorized(userId: string): boolean {
  return refreshTokenStore[userId] ? true : false;
}

//====================================================//
//   Using an Access Token to Query the HubSpot API   //
//====================================================//

async function getContact(accessToken: string): Promise<Contact> {
  console.log('');
  console.log(
    '=== Retrieving a contact from HubSpot using the access token ==='
  );
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    console.log('===> Replace the following fetch() to test other API calls');
    console.log(
      "===> fetch('https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1')"
    );
    const response = await fetch(
      'https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1',
      {
        headers: headers,
      }
    );

    if (!response.ok) {
      const errorBody = await response.json();
      console.error('  > Unable to retrieve contact');
      return errorBody;
    }

    const result = await response.json();
    return result.contacts[0];
  } catch (e) {
    console.error('  > Unable to retrieve contact');
    throw e;
  }
}

//========================================//
//   Displaying information to the user   //
//========================================//

interface ContactProperty {
  value: string;
}

interface Contact {
  status: string;
  message: string;
  properties: {
    firstname: ContactProperty;
    lastname: ContactProperty;
  };
}

const displayContactName = (res: Response, contact: Contact) => {
  if (contact.status === 'error') {
    res.write(
      `<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`
    );
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(`<p>Contact name: ${firstname.value} ${lastname.value}</p>`);
};

app.get('/', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h2>HubSpot OAuth 2.0 Quickstart App</h2>`);
  if (isAuthorized(req.sessionID)) {
    const accessToken = await getAccessToken(req.sessionID);
    const contact = await getContact(accessToken);
    res.write(`<h4>Access token: ${accessToken}</h4>`);
    displayContactName(res, contact);
  } else {
    res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  }
  res.end();
});

app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

export default app;
