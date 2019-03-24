/*
 *  Copyright 2016 Shaunak Kishore (kshaunak "at" gmail.com)
 *
 *  This file is part of Inkstone.
 *
 *  Inkstone is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  Inkstone is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with Inkstone.  If not, see <http://www.gnu.org/licenses/>.
 */

// Schema: vocabulary is a list of words that the user is studying, with info
// about how often they've seen that word, when they've seen it last, etc:
//  - word: string
//  - last: Unix timestamp when the word was last seen
//  - next: Unix timestamp when the word is next due
//  - lists: array of active lists that the word appears in
//  - attempts: number of times the user has seen the word
//  - successes: number of times the user has gotten the word right
//  - failed: true if this item should be shown again in the failures deck
//
// In addition, vocabulary has a 'blacklist' key whos value is a list of
// blacklist items. Each blacklist item has the keys 'word', 'pinyin', and
// 'definition'. Blacklisted words will never be part of the active set.
//
// The "updateItem" model method takes a "result" argument which should be a
// value in the set {0, 1, 2, 3}, with higher numbers indicating that the
// user made more errors.
import {getNextInterval} from '/client/external/inkren/interval_quantifier';
import {PersistentDict} from '/client/model/persistence';

const kNumChunks = 16;

const kColumns = 'word last next lists attempts successes failed'.split(' ');
const kIndices = {};
kColumns.forEach((x, i) => kIndices[x] = i);

const is_active = (entry) =>
    entry[kIndices.lists].length > 0 &&
    !cache.blacklist[entry[kIndices.word]];

const onload = (value) => {
  cache.active = [];
  cache.blacklist = {};
  cache.chunks = [];
  cache.index = {};
  (value.blacklist || []).forEach((x) => cache.blacklist[x.word] = x);
  _.range(kNumChunks).forEach((i) => {
    cache.chunks.push(value[i] || []);
    cache.chunks[i].forEach((entry) => {
      cache.index[entry[kIndices.word]] = entry;
      if (is_active(entry)) cache.active.push(entry);
    });
  });
}

const cache  = {active: [], blacklist: {}, chunks: [], index: {}};
const vocabulary = new PersistentDict('vocabulary', onload);

const chunk = (word) => cache.chunks[Math.abs(word.hash()) % kNumChunks];

const dirty = (word) => {
  const keys = word ? [Math.abs(word.hash()) % kNumChunks]
                    : _.range(kNumChunks);
  keys.forEach((key) => vocabulary.set(key, cache.chunks[key]));
}

const materialize = (entry) => {
  const result = {};
  kColumns.forEach((x, i) => result[x] = entry[i]);
  return result;
}

class Cursor {
  constructor(filter) {
    vocabulary.depend();
    this._list = filter ? cache.active.filter(filter) : cache.active;
  }
  count() {
    return this._list.length;
  }
  fetch() {
    return this._list.map(materialize);
  }
  next() {
    let count = 0;
    let first = null;
    let result = null;
    for (let entry of this._list) {
      const next = entry[kIndices.next] || Infinity;
      if (!result || next < first) {
        count = 1;
        first = next;
        result = entry;
      } else if (next === first) {
        count += 1;
        if (count * Math.random() < 1) {
          result = entry;
        }
      }
    }
    return result && materialize(result);
  }
}

class Vocabulary {
  static indices() {
    return kIndices;
  }
  static count(filter) {
    return new Cursor(filter).count()
  }
  static addItem(word, list) {
    check(word, String);
    if (!cache.index[word]) {
      const entry = [word, null, null, [], 0, 0, false];
      if (entry.length !== kColumns.length) throw new Error(entry);
      chunk(word).push(entry);
      cache.index[word] = entry;
    }
    const entry = cache.index[word];
    const lists = entry[kIndices.lists];
    if (lists.indexOf(list) < 0) {
      lists.push(list);
      if (lists.length === 1 && is_active(entry)) cache.active.push(entry);
    }
    dirty(word);
  }
  static clearFailed(item) {
    const entry = cache.index[item.word];
    if (entry) entry[kIndices.failed] = false;
    dirty(item.word);
  }
  static dropList(list) {
    const updated = {active: [], chunks: []};
    _.range(kNumChunks).forEach(() => updated.chunks.push([]));
    cache.chunks.forEach((chunk, i) => chunk.forEach((entry) => {
      const lists = entry[kIndices.lists].filter((x) => x !== list);
      if (lists.length + entry[kIndices.attempts] > 0) {
        entry[kIndices.lists] = lists;
        updated.chunks[i].push(entry);
        if (is_active(entry)) updated.active.push(entry);
      } else {
        delete cache.index[entry[kIndices.word]];
      }
    }));
    cache.active = updated.active;
    cache.chunks = updated.chunks;
    dirty();
  }
  static getBlacklistedWords() {
    return vocabulary.get('blacklist');
  }
  static getExtraItems(last) {
    return new Cursor((entry) => {
      return entry[kIndices.attempts] === 0 || entry[kIndices.next] < last;
    });
  }
  static getFailuresInRange(start, end) {
    return new Cursor((entry) => {
      if (!entry[kIndices.failed]) return false;
      const last = entry[kIndices.last];
      return start <= last && last < end;
    });
  }
  static getItemsDueBy(last, next) {
    return new Cursor((entry) => {
      if (entry[kIndices.attempts] === 0) return false;
      return entry[kIndices.last] < last && entry[kIndices.next] < next;
    });
  }
  static getNewItems() {
    return new Cursor((entry) => entry[kIndices.attempts] === 0);
  }
  static updateBlacklist(item, blacklisted) {
    const word = item.word;
    if (!!blacklisted === !!cache.blacklist[word]) return;
    if (blacklisted) {
      cache.blacklist[word] = item;
      cache.active = cache.active.filter((x) => x[kIndices.word] !== word);
    } else {
      delete cache.blacklist[word];
      const entry = cache.index[word];
      if (entry && is_active(entry)) cache.active.push(entry);
    }
    const value = Object.keys(cache.blacklist).map((x) => cache.blacklist[x]);
    vocabulary.set('blacklist', value);
  }
  static updateItem(item, result, ts) {
    const entry = cache.index[item.word];
    if (!entry || entry[kIndices.attempts] !== item.attempts) return;

    entry[kIndices.last] = ts;
    entry[kIndices.next] = ts + getNextInterval(item, result, ts);

    const success = result < 3;
    entry[kIndices.attempts] = item.attempts + 1;
    entry[kIndices.successes] = item.successes + (success ? 1 : 0);
    entry[kIndices.failed] = !success;
    dirty(item.word);
  }
}

export {Vocabulary};
