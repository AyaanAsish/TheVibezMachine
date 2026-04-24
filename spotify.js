const http = require('http')
const { URL } = require('url')
const crypto = require('crypto')

// Spotify OAuth configuration
const LOCAL_PORT = 8080
// Use 127.0.0.1 instead of 'localhost' - Spotify banned localhost but loopback IPs still work
let REDIRECT_URI = `http://127.0.0.1:${LOCAL_PORT}`
const SCOPE = 'user-read-private user-read-email user-read-playback-state user-modify-playback-state playlist-read-private playlist-modify-public playlist-modify-private'

let CLIENT_ID = ''
let CLIENT_SECRET = ''

// Generate random state for CSRF protection
function generateRandomString(length) {
  return crypto.randomBytes(length).toString('hex')
}

// Get authorization URL
function getAuthorizeUrl(state) {
  return `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}&state=${state}`
}

// Exchange code for access token
async function getAccessToken(code) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64')
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    })
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }

  return response.json()
}

// Test API call
async function testApiCall(accessToken) {
  const response = await fetch('https://api.spotify.com/v1/me', {
    headers: {
      'Authorization': 'Bearer ' + accessToken
    }
  })

  if (!response.ok) {
    throw new Error(`API call failed: ${response.status}`)
  }

  return response.json()
}

// Main CLI flow
async function main() {
  console.log('=== Spotify Web API Authentication ===\n')
  console.log('Note: Using 127.0.0.1 instead of localhost (Spotify banned localhost redirect URIs)')
  console.log('Add this to your Spotify Dashboard redirect URIs: http://127.0.0.1:8080\n')

  // Get Client ID
  const clientId = await prompt('Enter your Spotify Client ID: ')
  CLIENT_ID = clientId.trim()

  // Get Client Secret (optional for now, needed for token exchange)
  const clientSecret = await prompt('Enter your Spotify Client Secret (or press Enter to skip): ')
  CLIENT_SECRET = clientSecret.trim()

  const state = generateRandomString(16)
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}&state=${state}`

  console.log('\n--- Step 1: Authorize ---')
  console.log('Open this URL in your browser:')
  console.log(authUrl)
  console.log(`\nAfter authorizing, you will be redirected to ${REDIRECT_URI}`)
  console.log('The app will capture the authorization code automatically.\n')

  // Start server to catch redirect
  const authCode = await waitForAuthCode(LOCAL_PORT)

  if (!authCode) {
    console.log('No authorization code received. Exiting.')
    return
  }

  console.log('Authorization code received:', authCode.substring(0, 10) + '...')

  // Exchange code for tokens
  if (!CLIENT_SECRET) {
    console.log('\n--- Token Exchange Skipped ---')
    console.log('No Client Secret provided. You can manually exchange the code using curl:')
    console.log(`curl -X POST "https://accounts.spotify.com/api/token" \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -H "Authorization: Basic $(echo -n '${CLIENT_ID}:YOUR_CLIENT_SECRET' | base64)" \\
  -d "grant_type=authorization_code&code=${authCode}&redirect_uri=${REDIRECT_URI}"`)
    return
  }

  console.log('\n--- Step 2: Exchange Code for Tokens ---')
  try {
    const tokenData = await getAccessToken(authCode)
    console.log('Access Token:', tokenData.access_token.substring(0, 20) + '...')
    console.log('Refresh Token:', tokenData.refresh_token ? tokenData.refresh_token.substring(0, 20) + '...' : 'N/A')
    console.log('Expires In:', tokenData.expires_in, 'seconds')

    // Test API call
    console.log('\n--- Step 3: Test API Call ---')
    const userData = await testApiCall(tokenData.access_token)
    console.log('Successfully authenticated as:', userData.display_name || userData.id)
    console.log('Email:', userData.email)

    // Save credentials
    console.log('\n--- Save These Credentials ---')
    console.log('Add this to your settings/config file:')
    console.log(JSON.stringify({
      clientId: CLIENT_ID,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenExpiry: Date.now() + (tokenData.expires_in * 1000)
    }, null, 2))

  } catch (err) {
    console.error('Error:', err.message)
  }
}

// Prompt helper
function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    process.stdin.once('data', (data) => {
      resolve(data.toString().trim())
    })
  })
}

// Wait for authorization code from redirect
function waitForAuthCode(port) {
  return new Promise((resolve) => {
    let authCode = null

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      if (url.pathname === '/' && url.searchParams.has('code')) {
        authCode = url.searchParams.get('code')

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <html>
            <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#191414;color:white;">
              <div style="text-align:center;">
                <h1>Spotify Auth Successful!</h1>
                <p>You can close this window and return to the terminal.</p>
              </div>
            </body>
          </html>
        `)

        setTimeout(() => {
          server.close()
          resolve(authCode)
        }, 1000)
      } else {
        res.writeHead(404)
        res.end('Not found - expected /?code=...')
      }
    })

    server.listen(port, () => {
      console.log(`Listening for redirect on http://127.0.0.1:${port}`)
    })

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!authCode) {
        server.close()
        resolve(null)
      }
    }, 120000)
  })
}

// Run if called directly
main()
