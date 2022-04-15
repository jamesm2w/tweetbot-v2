# tweetbot-v2
Rewrite of Tweetbot to send tweets from certain accounts to a customisable webhook URL built with library support to be much more robust.

Written in Node.js, with a MongoDB connection and a Twitter API v2 account.

## Running
```bash
npm test
```
Will run the basic server.
Needs a `.env` file with the following environment variables:
```
API_KEY=[Optional Twitter API key]
API_SECRET=[Optional Twitter API secret]
BEARER_TOKEN=[Twitter API token]
CONNECTIONSTRING=[Mongo DB connection URL]
PORT=[Optional port of listening server]
DEBUG_WEBHOOK_URL=[Debug webhook URL to send info messages to]
OWNER=[Discord owner ID if using Discord]
```
