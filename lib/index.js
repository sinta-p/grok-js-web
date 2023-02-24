const debug = require('debug')('grok-js');
const Map = require('collections/fast-map');
const { OnigRegExp } = require('onigasm');
const { fromCallback } = require('universalify');

function GrokPattern(expression, id) {
  const t = this;

  t.id = id;
  t.expression = expression;
  t.fields = [null]; // add a dummy entry at the beginning to swallow the fully captured expression
  t.resolved = null;
  t.regex = null;

  t.parse = fromCallback(function parse(str, next) {
    if (!t.regexp) {
      t.regexp = new OnigRegExp(t.resolved);
    }

    t.regexp.search(str, (err, result) => {
      if (err || !result) {
        return next(err, result);
      }

      const r = {};

      result.forEach((item, index) => {
        const field = t.fields[index];

        if (field && item.match) {
          r[field] = item.match;
        }
      });

      return next(err, r, result);
    });
  });

  t.parseSync = (str) => {
    if (!t.regexp) {
      t.regexp = new OnigRegExp(t.resolved);
    }

    const result = t.regexp.searchSync(str);

    if (!result) {
      return null;
    }

    const r = {};

    result.forEach((item, index) => {
      const field = t.fields[index];
      if (field && item.match) {
        r[field] = item.match;
      }
    });

    return r;
  };
}

const subPatternsRegex = /%\{[A-Za-z0-9_]+(?::[A-Za-z0-9_]+)?(?::[A-Za-z]+)?\}/g; // %{subPattern} or %{subPattern:fieldName}
const nestedFieldNamesRegex = /(\(\?<([A-Za-z0-9_]+)>)|\(\?:|\(\?>|\(\?!|\(\?<!|\(|\\\(|\\\)|\)|\[|\\\[|\\\]|\]/g;

function GrokCollection() {
  const t = this;
  const patterns = new Map();
  const resolvePattern = (pattern) => {
    pattern = resolveSubPatterns(pattern);
    pattern = resolveFieldNames(pattern);

    return pattern;
  };

  // detect references to other patterns
  // TODO: support automatic type conversion (e.g., "%{NUMBER:duration:float}"; see: https://www.elastic.co/guide/en/logstash/current/plugins-filters-grok.html)
  const resolveSubPatterns = (pattern) => {
    if (!pattern) {
      return;
    }

    let expression = pattern.expression;
    const subPatterns = expression.match(subPatternsRegex) || [];

    subPatterns.forEach((matched) => {
      // matched is: %{subPatternName} or %{subPatternName:fieldName}
      let subPatternName = matched.substr(2, matched.length - 3);
      const elements = subPatternName.split(':');

      subPatternName = elements[0];

      const fieldName = elements[1];
      const subPattern = patterns.get(subPatternName);

      if (!subPattern) {
        debug('Error: pattern "' + subPatternName + '" not found!');
        return;
      }

      if (!subPattern.resolved) {
        resolvePattern(subPattern);
      }

      if (fieldName) {
        expression = expression.replace(matched, '(?<' + fieldName + '>' + subPattern.resolved + ')');
      } else {
        expression = expression.replace(matched, subPattern.resolved);
      }
    });

    pattern.resolved = expression;
    return pattern;
  };

  // create mapping table for the fieldNames to capture
  const resolveFieldNames = (pattern) => {
    if (!pattern) {
      return;
    }

    let nestLevel = 0;
    let inRangeDef = 0;
    let matched;

    while ((matched = nestedFieldNamesRegex.exec(pattern.resolved)) !== null) {
      switch (matched[0]) {
        case '(': {
          if (!inRangeDef) {
            nestLevel = nestLevel + 1;
            pattern.fields.push(null);
          }
          break;
        }
        case '\\(':
          break; // can be ignored
        case '\\)':
          break; // can be ignored
        case ')': {
          if (!inRangeDef) {
            nestLevel = nestLevel - 1;
          }
          break;
        }
        case '[': {
          ++inRangeDef;
          break;
        }
        case '\\[':
          break; // can be ignored
        case '\\]':
          break; // can be ignored
        case ']': {
          --inRangeDef;
          break;
        }
        case '(?:': // fallthrough                // group not captured
        case '(?>': // fallthrough                // atomic group
        case '(?!': // fallthrough                // negative look-ahead
        case '(?<!': {
          if (!inRangeDef) {
            nestLevel = nestLevel + 1;
          }
          break;
        } // negative look-behind
        default: {
          nestLevel++;
          pattern.fields.push(matched[2]);
          break;
        }
      }
    }

    return pattern;
  };

  const patternLineRegex = /^([A-Z0-9_]+)\s+(.+)/;
  const splitLineRegex = /\r?\n/;

  const doLoad = (text) => {
    const ids = [];

    if (text) {
      const lines = text.toString().split(splitLineRegex);

      if (lines && lines.length) {
        lines.forEach((line) => {
          const elements = patternLineRegex.exec(line);

          if (elements && elements.length > 2) {
            const pattern = new GrokPattern(elements[2], elements[1]);

            patterns.set(pattern.id, pattern);
            ids.push(pattern.id);
          }
        });
      }
    }

    return ids;
  };

  t.createPattern = (expression, id) => {
    id = id || 'pattern-' + patterns.length;

    if (patterns.has(id)) {
      debug('Error: pattern with id %s already exists', id);
    } else {
      const pattern = new GrokPattern(expression, id);

      resolvePattern(pattern);
      patterns.set(id, pattern);

      return pattern;
    }
  };

  t.getPattern = (id) => {
    return resolvePattern(patterns.get(id));
  };

  t.load = (url) => {
    return fetch(url)
      .then((res) => res.text())
      .then((text) => doLoad(text))
      .catch((err) => console.error(err));
  };

  t.count = () => {
    return patterns.length;
  };
}

module.exports = {
  GrokCollection: GrokCollection,
};
