/*
 * Server side game module. Maintains the game state and processes all the messages from clients.
 *
 * Exports:
 *   - addPlayer(name)
 *   - move(direction, name)
 *   - state()
 */

const { clamp, randomPoint, permutation } = require('./gameutil');
const redis = require('redis').createClient({host: 'localhost', port: 6379, db: 0});
const Promise = require("bluebird");
Promise.promisifyAll(require("redis"));

const WIDTH = 64;
const HEIGHT = 64;
const MAX_PLAYER_NAME_LENGTH = 32;
const NUM_COINS = 10;

redis.on('error', error => {
  console.error(error);
});

// A KEY-VALUE "DATABASE" FOR THE GAME STATE.
//
// The game state is maintained in an object. Your homework assignment is to swap this out
// for a Redis database.
//
// In this version, the players never die. For homework, you need to make a player die after
// five minutes of inactivity. You can use the Redis TTL for this.
//
// Here is how the storage is laid out:
//
// player:<name>    string       "<row>,<col>"
// scores           sorted set   playername with score
// coins            hash         { "<row>,<col>": coinvalue }
// usednames        set          all used names, to check quickly if a name has been used
//
const database = {
  scores: {},
  usednames: new Set(),
  coins: {},
};

exports.addPlayer = (name) => {
  if (name.length === 0 || name.length > MAX_PLAYER_NAME_LENGTH || database.usednames.has(name)) {
    return false;
  }
  redis.sadd('usednames', name);
  database.usednames.add(name);

  point = randomPoint(WIDTH, HEIGHT).toString();
  redis.set(`player:${name}`, point);
  database[`player:${name}`] = point;

  redis.zadd('scores', 0, name);
  database.scores[name] = 0;

  return true;
};

function placeCoins() {
  permutation(WIDTH * HEIGHT).slice(0, NUM_COINS).forEach((position, i) => {
    const coinValue = (i < 50) ? 1 : (i < 75) ? 2 : (i < 95) ? 5 : 10;
    const index = `${Math.floor(position / WIDTH)},${Math.floor(position % WIDTH)}`;
    redis.hset('coins', index, coinValue);
    database.coins[index] = coinValue;
  });
}

function getValues(callback) {
    redis.multi()
    .keys('player:*')
    .zrevrangebyscore('scores', '+inf', '-inf', 'withscores')
    .hgetall('coins').execAsync().then((res, err) => {
      const names = res[0].map((key) => key.substring(7));
      const scores = [];
      for (let i = 0; i < res[1].length; i += 2) {
        scores.push([res[1][i], res[1][i+1]]);
      }
      const coins = res[2];
      return redis.mgetAsync(res[0]).then((res, err) => {
        const pos = res;
        const positions = names.map((e, i) => { return[e, pos[i]] });
        callback([positions, scores, coins]);
      });
    });
}

// Return only the parts of the database relevant to the client. The client only cares about
// the positions of each player, the scores, and the positions (and values) of each coin.
// Note that we return the scores in sorted order, so the client just has to iteratively
// walk through an array of name-score pairs and render them.
exports.state = () => {
  const positions = Object.entries(database)
    .filter(([key]) => key.startsWith('player:'))
    .map(([key, value]) => [key.substring(7), value]);
  const scores = Object.entries(database.scores);
  scores.sort(([, v1], [, v2]) => v2 - v1);

  getValues(function(values) {
    const positions = values[0];
    const scores = values[1];
    const coins = values[2];
  });

  return {
    positions,
    scores,
    coins: database.coins,
  };
};


exports.move = (direction, name) => {
  const delta = { U: [0, -1], R: [1, 0], D: [0, 1], L: [-1, 0] }[direction];
  if (delta) {
    const playerKey = `player:${name}`;
    // const [x, y] = database[playerKey].split(',');
    // const value = database.coins[`${newX},${newY}`];

    return redis.getAsync(playerKey).then(function(resolve, reject) {
      const [x, y] = resolve.split(',');
      const [newX, newY] = [clamp(+x + delta[0], 0, WIDTH - 1), clamp(+y + delta[1], 0, HEIGHT - 1)];

      return redis.multi()
        .hget('coins', `${newX},${newY}`)
        .hgetall('coins').execAsync().then(function(resolve, reject) {

          const value = resolve[0];
          if (value) {
            redis.zincrby('scores', value, name, function (e,r) {});
            database.scores[name] += value;
            redis.hdel('coins', `${newX},${newY}`, function (e,r) {});
            delete database.coins[`${newX},${newY}`];
          }
          redis.set(playerKey, `${newX},${newY}`, function (e,r) {});
          database[playerKey] = `${newX},${newY}`;

          if (resolve[1] === null) {
            placeCoins();
          }
      });
    });
  }
};

redis.on('error', error => {
  console.error(error);
});

placeCoins();
