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
    var url = 'https://www.reddit.com/r/DotA2/top.json?sort=top&t=day&limit=' + config.reddit.limit;

    request({
        url: url,
        json: true,
        headers: {
            'User-Agent': config.reddit.user_agent
        }
    }, function (err, response, body) {
        if (err) {
            console.log(err);
            return false;
        }

        if (response.statusCode === 200) {
            db.run('BEGIN');
            body.data.children.forEach(function (submission) {
                db.run('INSERT OR IGNORE INTO posts (id, title, permalink, url) VALUES ($id, $title, $permalink, $url)', {
                    $id: submission.data.id,
                    $title: submission.data.title,
                    $permalink: submission.data.permalink,
                    $url: submission.data.url
                });
            });
            db.run('COMMIT');

            postTwitterSubmissions();
        }
    });
}

function postTwitterSubmissions () {
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

        db.run('UPDATE posts SET tweeted = CURRENT_TIMESTAMP WHERE id = $id', {$id: row.id});

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

        twitter.post('statuses/update', {status: tweet}, function (err, data, response) {
            var now = new Date();
            console.log('[' + now.toUTCString() + '] ' + tweet);
            if (err) {
                console.log(err);
                return false;
            }

            var re = /twitter\.com\/.*status\/([0-9]+)/;
            var match = re.exec(row.url);

            if (match && match[1]) {
                console.log('[' + now.toUTCString() + '] Retweeting ' + row.url);
                twitter.post('statuses/retweet/:id', { id: match[1] }, function (err, data, response) {
                    if (err) {
                        console.log(err);
                        return false;
                    }
                });
            }
        });
    });
}
