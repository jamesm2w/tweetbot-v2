import { ETwitterStreamEvent, TwitterApi, TwitterV2IncludesHelper  } from "twitter-api-v2"; 
import { WebhookClient } from "discord.js";
import { MongoClient } from "mongodb";

import "dotenv/config";

const twitterClient = new TwitterApi(process.env.BEARER_TOKEN);
const client = twitterClient.v2;

const debug_discordWebhookClient = new WebhookClient({ url: process.env.DEBUG_WEBHOOK_URL });

const dbClient = new MongoClient(process.env.CONNECTIONSTRING);

const sendInfoMessage = async (content, level=0) => {
    debug_discordWebhookClient.send({
        content: level > 0 ? `<@${process.env.OWNER}> Urgent:` : "Info:",
        embeds: [{
            description: content
        }]
    });
}

const getRules = async () => {
    return client.streamRules();
}

const addRules = async (rules) => {
    return client.updateStreamRules({
        add: rules
    });
}

const deleteRules = async (rules) => {
    return client.updateStreamRules({
        delete: rules
    });
}

const connectStream = async () => {
    const stream = client.searchStream({ 
        autoConnect: false, 
        expansions: ["author_id", "referenced_tweets.id", "referenced_tweets.id.author_id"],
        "user.fields": ["name","username","profile_image_url", "id"],
        "tweet.fields": ["author_id", "id"]
    });
    
    stream.on(ETwitterStreamEvent.Data, async (data) => {
        
        const includes = new TwitterV2IncludesHelper(data);

        const tweet = data.data;
        const originalAuthor = includes.author(tweet);

        const retweet = includes.retweet(tweet);

        const isRetweet = retweet != undefined;
        let retweetAuthor;
        if (isRetweet)
            retweetAuthor = includes.author(retweet);

        const tweet_url = `https://twitter.com/${isRetweet ? retweetAuthor.username : originalAuthor.username}/status/${isRetweet ? retweet.id : tweet.id }`; 
        console.log("New Tweet ", tweet_url);

        const database = dbClient.db("tweetbotv2");
        const channelCollection = database.collection("channels");
        
        let channels = await channelCollection.find({
            "accounts": { $in: [ originalAuthor.username.toString() ] },
        }).toArray();

        for (let channel of channels) {
            let discordWebhookClient = new WebhookClient({ url: channel.webhook });
            await discordWebhookClient.send({
                content: `${isRetweet ? "RT" : ""} ${tweet_url}`,
                username: originalAuthor.name,
                avatarURL: TwitterApi.getProfileImageInSize(originalAuthor.profile_image_url, "original")
            });
        }
    });
    
    stream.on(ETwitterStreamEvent.Connected, () => {
        console.log("Connected To Twitter");
        sendInfoMessage("Tweetbot CONNECTED to Stream API");
    });
    
    stream.on(ETwitterStreamEvent.ConnectionLost, () => {
        console.log("Lost Connection to Twitter");
        sendInfoMessage("Tweetbot CONNECTION LOST to Stream API", 1);
    });

    stream.on(ETwitterStreamEvent.ConnectionClosed, () => {
        console.log("Twitter Stream Closed");
        sendInfoMessage("Tweetbot CONNECTION CLOSED to Stream API", 1);
    })
    
    stream.on(ETwitterStreamEvent.Error, (err) => { // When twitter sends something which could not be JSON parsed or network error 
        console.log("Stream Error");
        console.error("Stream Error. ", err.message);
        console.error("Twitter Information, ", err.error.data);
        console.log(err);
        sendInfoMessage("Tweetbot encountered unexpected error with Stream API");
    });

    stream.on(ETwitterStreamEvent.ReconnectAttempt, () => {
        console.log("Reconnect Attempt");
    });

    stream.on(ETwitterStreamEvent.Reconnected, () => {
        console.log("Reconnected")
        sendInfoMessage("Tweetbot reconnected to Stream API", 1);
    });

    stream.on(ETwitterStreamEvent.ReconnectLimitExceeded, () => {
        console.log("Reconnect Limit Exceeded");
        sendInfoMessage("Tweetbot reconnect limit exceeded to Stream API. Will not try again.", 1);
    });

    await stream.connect({ autoReconnect: true, autoReconnectRetries: 10 });

    return stream;
};

const createRuleset = (channelLists) => {
    let uniqueAccountList = [];

    for (let channelList of channelLists) {
        for (let account of channelList.accounts) {

            if (!uniqueAccountList.includes(account)) {
                uniqueAccountList.push(account);
            }

        }
    }

    let ruleList = [];
    let currentRuleStr = "";

    for (let account of uniqueAccountList) {
        let newRulePart = `from:${account}`;

        if (currentRuleStr.length != 0) newRulePart = " OR " + newRulePart;

        if (currentRuleStr.length + newRulePart.length > 512) {
            ruleList.push({ value: currentRuleStr, tag: `Rule${ruleList.length+1}` });
            currentRuleStr = newRulePart.substring(4);
        } else {
            currentRuleStr += newRulePart;
        }
    }

    if (currentRuleStr.length != 0) {
        ruleList.push({ value: currentRuleStr, tag: `Rule${ruleList.length+1}` });
    }

    if (ruleList.length > 25) {
        console.error("Created more than 25 rules. Only applying the first 25.");
        ruleList = ruleList.slice(0, 24);
    }

    return ruleList;
}

const recreateRulesThroughDB = async () => {
    try {
        console.log("Creating Rules via DB");
        const database = dbClient.db("tweetbotv2");
        const channelCollection = database.collection("channels");
        const channels = await channelCollection.find({}).toArray();
    
        let curRules = await getRules();
        let computedRuleset = createRuleset(channels);
        console.log("Computed Rules", computedRuleset);

        if (curRules.meta.result_count > 0) {
            await deleteRules({ids: curRules.data?.map(rule => rule.id)});
        }
        let result = await addRules(computedRuleset); 
        
        if (result.meta?.summary?.invalid > 0) {
            throw Error("Invalid Rules were generated");
        }

        console.log("Cleared & Added Rules", result);
    } catch (err) {
        console.log("Error creating rules from DB");
        console.error("Error Information: ", err);
        console.error("Stream Errors", err.errors);
        sendInfoMessage("Tweetbot Error in Creating Rules from MongoDB.");
    }
}

async function run () {
    let filteredStream;
    try {
        await dbClient.connect();
        const database = dbClient.db("tweetbotv2");
        const channelCollection = database.collection("channels");

        await recreateRulesThroughDB();

        sendInfoMessage("TweetbotV2 Starting Up.\nConnected to MongoDB\nCreated Ruleset\nAttempting to connect to twitter.")

        filteredStream = await connectStream();
        
        channelCollection.watch().on("change", () => {
            console.log("Change Detected in MongoDB");
            sendInfoMessage("Change Detected in MongoDB.");
            recreateRulesThroughDB();
        });
    } catch (err) {
        console.error(err);

        await dbClient.close();
        filteredStream.close();

        console.log("Closed streams and shutdown");
        sendInfoMessage("Tweetbot SHUTDOWN");
    }
}

await run();