var base64 = require('node-base64-image');
var config = require('./config.json');
var path = require('path');
var request = require('request');
var Sqlite3 = require('sqlite3').verbose();
var Twit = require('twit');
var twitterText = require('twitter-text');

var db = new Sqlite3.Database(path.join(__dirname, 'db.sqlite'), initDb);

function initDb () {
    db.run(
        'CREATE TABLE IF NOT EXISTS posts (' +
        'id TEXT PRIMARY KEY NOT NULL,' +
        'title TEXT NOT NULL,' +
        'permalink TEXT NOT NULL,' +
        'url TEXT NOT NULL,' +
        'added TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,' +
        'tweeted TIMESTAMP)',
        getRedditPosts
    );
}

function getRedditPosts () {
    request({
        url: config.reddit.url,
        json: true,
        headers: {
            'User-Agent': config.reddit.user_agent
        }
    }, function (err, response, body) {
        if (err) {
            console.log(err);
            return false;
        }

        if (response.statusCode === 200 && body.data.children.length > 0) {
            var submissions = [];

            body.data.children.forEach(function (submission) {
                if (!config.reddit.min_score || (config.reddit.min_score && submission.data.score > 10)) {
                    submissions.push(submission);
                }
            });

            if (submissions.length > 0) {
                db.run('BEGIN');

                submissions.forEach(function (submission) {
                    db.run('INSERT OR IGNORE INTO posts (id, title, permalink, url) VALUES ($id, $title, $permalink, $url)', {
                        $id: submission.data.id,
                        $title: submission.data.title,
                        $permalink: submission.data.permalink,
                        $url: submission.data.url
                    });
                });

                db.run('COMMIT');

                processTwitterSubmissions();
            }
        }
    });
}

function processTwitterSubmissions () {
    var twitter = new Twit({
        consumer_key: config.twitter.consumer_key,
        consumer_secret: config.twitter.consumer_secret,
        access_token: config.twitter.access_token,
        access_token_secret: config.twitter.access_token_secret
    });

    db.each('SELECT * FROM posts WHERE tweeted IS NULL', function (err, row) {
        if (err) {
            console.log(err);
            return false;
        }

        var tweet = row.title + ' https://www.reddit.com' + row.permalink;
        var tweetLength = twitterText.getTweetLength(tweet);

        if (tweetLength > 140) {
            var lengthOver = tweetLength - 140;

            // Remove characters that make the tweet too long from the title and remove potential whitespace from the end
            var title = row.title.slice(0, -(lengthOver + 3)).trim();
            // Remove the last word from the title, it might be cut off in the middle because of the previous operation
            title = title.substring(0, title.lastIndexOf(' '));
            // Add ellipsis to the end of the title
            title = title + '...';

            // Rebuild the tweet with the new, shortened title
            tweet = title + ' https://www.reddit.com' + row.permalink;
        }

        // If the submission is a tweet, append the URL to the end of our tweet. This will result in Twitter quoting the
        // tweet, which also removes the URL from the tweet itself, and means it won't count towards the character limit
        var tweet_re = /twitter\.com\/.*status\/([0-9]+)/;
        var tweet_match = tweet_re.exec(row.url);

        if (tweet_match && tweet_match[1]) {
            tweet = tweet + ' ' + row.url;

            return postTwitterSubmission(twitter, {status: tweet});
        }

        // If the submission is a direct image link we attach it to the tweet directly
        var img_re = /\.(?:jpe?g|gif|png)$/i;
        var img_match = img_re.exec(row.url);

        if (img_match && img_match[0]) {
            console.log('Is image...');

            return base64.base64encoder(row.url, {string: true}, function (err, image) {
                if (err) {
                    console.log(err);
                    return false;
                }

                console.log('Got image...');

                return twitter.post('media/upload', {media_data: image}, function (err, data, response) {
                    if (err) {
                        console.log(err);
                        return false;
                    }

                    console.log('Uploaded image...');

                    console.log(tweet);

                    return postTwitterSubmission(twitter, {status: tweet, media_ids: [data.media_id_string]});
                });
            });
        }

        return postTwitterSubmission(twitter, {status: tweet});
    });
}

function postTwitterSubmission (twitter, params) {
    return twitter.post('statuses/update', params, function (err, data, response) {
        var now = new Date();
        console.log('[' + now.toUTCString() + '] ' + params.status);

        if (err) {
            console.log(err);
            return false;
        }

        db.run('UPDATE posts SET tweeted = CURRENT_TIMESTAMP WHERE id = $id', {$id: row.id});

        return true;
    });
}
