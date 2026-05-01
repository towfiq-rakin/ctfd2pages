const assert = require('node:assert');
const crypto = require('node:crypto');
const realfs = require('node:fs');
const path = require('node:path');

const {glob} = require('glob');
const {JSDOM} = require('jsdom');
const {Volume} = require('memfs');
const {Union} = require('unionfs');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');
const yaml = require('js-yaml');

const {PAGES_REPO, CHAL_REPO, EXPORT_PATH, IS_CORE_BETA} = process.env;

const INJECTED_JS_PATH = '/ctfd2pages/hooks/challenges.min.js';
const STATIC_ARCHIVE_SHIM_PATH = '/ctfd2pages/hooks/static-archive.js';
const STATIC_ARCHIVE_SHIM = String.raw`(() => {
  const unavailable = (message, status = 200, extra = {}) => new Response(
      JSON.stringify({success: true, data: [], ...extra}),
      {
        status,
        headers: {
          'content-type': 'application/json',
          'x-ctfd2pages-static': message,
        },
      },
  );

  if (window.__ctfd2pagesStaticShimInstalled) {
    return;
  }
  window.__ctfd2pagesStaticShimInstalled = true;

  const originalFetch = window.fetch.bind(window);

  const makeRequest = (url, input, init) => {
    if (input instanceof Request) {
      return new Request(url, {
        method: input.method,
        headers: input.headers,
        cache: input.cache,
        credentials: input.credentials,
        integrity: '',
        keepalive: input.keepalive,
        mode: input.mode,
        redirect: input.redirect,
        referrer: input.referrer,
        referrerPolicy: input.referrerPolicy,
        signal: input.signal,
      });
    }
    return [url, init];
  };

  const asJsonFetch = (url, input, init) => {
    const next = makeRequest(url, input, init);
    return Array.isArray(next) ?
      originalFetch(next[0], next[1]) :
      originalFetch(next);
  };

  const mapApiRequest = (parsed, method) => {
    const path = parsed.pathname;
    const search = parsed.search;

    if (path === '/api/v1/users/me') {
      return unavailable('users/me unavailable in static archive',
          200, {data: {score: 0, place: null}});
    }
    if (path === '/api/v1/users/me/solves') {
      return unavailable('users/me/solves unavailable in static archive',
          200, {meta: {count: 0}});
    }
    if (path === '/api/v1/brackets') {
      return unavailable('brackets unavailable in static archive');
    }
    if (path === '/api/v1/notifications') {
      return unavailable('notifications unavailable in static archive');
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return unavailable('static archive cannot ' + method + ' ' + path, 200,
          {success: false, errors: ['This archive is read-only.']});
    }

    if (path === '/api/v1/scoreboard' || path === '/api/v1/challenges') {
      return asJsonFetch(path + '/index.json', inputArg, initArg);
    }

    if (/^\/api\/v1\/challenges\/\d+$/.test(path)) {
      return asJsonFetch(path + '/index.json', inputArg, initArg);
    }

    if (path === '/api/v1/scoreboard/top/15') {
      return asJsonFetch('/api/v1/scoreboard/top/10', inputArg, initArg);
    }

    if (search === '?since_id=0' && path === '/api/v1/notifications') {
      return unavailable('notifications unavailable in static archive');
    }

    return null;
  };

  let inputArg = null;
  let initArg = null;

  window.fetch = async (input, init) => {
    inputArg = input;
    initArg = init;

    const url = input instanceof Request ? input.url : String(input);
    const method = (init && init.method) ||
      (input instanceof Request ? input.method : 'GET');
    const parsed = new URL(url, window.location.href);

    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/')) {
      return originalFetch(input, init);
    }

    const mapped = mapApiRequest(parsed, method.toUpperCase());
    if (mapped) {
      return mapped;
    }
    return originalFetch(input, init);
  };
})();`;

const makeFlagsJson = async () => {
  const chalname2id = {};
  for (const chalJsonPath of await glob(
      `${PAGES_REPO}/api/v1/challenges/*/index.json`)) {
    const chalJson = JSON.parse(await realfs.promises.readFile(chalJsonPath));
    chalname2id[chalJson.data.name] = chalJson.data.id;
  }

  const flags = {};
  if (EXPORT_PATH?.length) {
    const chalIds = Object.values(chalname2id);
    const flagsJson = JSON.parse(await realfs.promises.readFile(
        `${EXPORT_PATH}/db/flags.json`));
    for (const entry of flagsJson.results) {
      const {challenge_id: id, content: flag} = entry;
      if (!chalIds.includes(id)) {
        console.log(`Unknown challenge id ${id} with flag "${flag}"`);
        continue;
      }

      const hash = crypto.createHash('sha256').update(flag).digest('hex');

      if (flags[id] === undefined) {
        flags[id] = [];
      }
      flags[id].push(hash);
    }
  } else {
    for (const chalYmlPath of await glob(
        `${CHAL_REPO}/**/challenge.yml`)) {
      yaml.loadAll(await realfs.promises.readFile(chalYmlPath), (doc) => {
        const name = doc.name;
        if (!(name in chalname2id)) {
          console.log(`Unknown challenge "${name}"`);
          return;
        }
        const id = chalname2id[name];

        for (const flag of doc.flags) {
          const hash = crypto.createHash('sha256').update(flag).digest('hex');

          if (flags[id] === undefined) {
            flags[id] = [];
          }
          flags[id].push(hash);
        }
      });
    }
  }

  for (const [name, id] of Object.entries(chalname2id)) {
    if (flags[id] === undefined) {
      console.log(`No flag found for challenge ${name}`);
    }
  }

  return flags;
};

const makeDetailsJson = async () => {
  if (!EXPORT_PATH?.length) {
    return {};
  }

  const readResults = async (filename) => {
    const fullpath = `${EXPORT_PATH}/db/${filename}`;
    if (!realfs.existsSync(fullpath)) {
      return [];
    }
    const raw = await realfs.promises.readFile(fullpath, 'utf8');
    if (!raw.trim()) {
      return [];
    }

    try {
      return JSON.parse(raw).results || [];
    } catch (err) {
      console.log(`Skipping ${filename}: ${err.message}`);
      return [];
    }
  };

  const challengeRows = await readResults('challenges.json');
  const fileRows = await readResults('files.json');
  const hintRows = await readResults('hints.json');
  const ratingRows = await readResults('ratings.json');
  const solveRows = await readResults('solves.json');

  const challengeFiles = new Map();
  for (const fileRow of fileRows) {
    if (!fileRow.challenge_id) {
      continue;
    }

    const files = challengeFiles.get(fileRow.challenge_id) || [];
    files.push({
      id: fileRow.id,
      url: `/files/${fileRow.location}`,
      name: path.basename(fileRow.location),
    });
    challengeFiles.set(fileRow.challenge_id, files);
  }

  const challengeHints = new Map();
  for (const hintRow of hintRows) {
    const hints = challengeHints.get(hintRow.challenge_id) || [];
    hints.push({
      id: hintRow.id,
      title: hintRow.title || 'Hint',
      content: hintRow.content || '',
      cost: hintRow.cost || 0,
      requirements: hintRow.requirements || {prerequisites: []},
    });
    challengeHints.set(hintRow.challenge_id, hints);
  }

  const challengeRatings = new Map();
  for (const ratingRow of ratingRows) {
    const current = challengeRatings.get(ratingRow.challenge_id) || {
      likes: 0,
      dislikes: 0,
    };
    if (ratingRow.value >= 1) {
      current.likes += 1;
    } else if (ratingRow.value <= 0) {
      current.dislikes += 1;
    }
    challengeRatings.set(ratingRow.challenge_id, current);
  }

  const challengeSolveCounts = new Map();
  for (const solveRow of solveRows) {
    challengeSolveCounts.set(
        solveRow.challenge_id,
        (challengeSolveCounts.get(solveRow.challenge_id) || 0) + 1,
    );
  }

  const details = {};
  for (const row of challengeRows) {
    details[row.id] = {
      id: row.id,
      name: row.name,
      description: row.description || '',
      max_attempts: row.max_attempts || 0,
      value: row.value,
      category: row.category,
      solves: challengeSolveCounts.get(row.id) || 0,
      type: row.type,
      state: row.state,
      connection_info: row.connection_info,
      next_id: row.next_id,
      attribution: row.attribution,
      ratings: challengeRatings.get(row.id) || {likes: 0, dislikes: 0},
      files: challengeFiles.get(row.id) || [],
      hints: challengeHints.get(row.id) || [],
    };
  }

  return details;
};

const makeWebpack = async (flags, isBetaTheme) => {
  const details = await makeDetailsJson();
  const memfs = Volume.fromJSON({
    './flags.json': JSON.stringify(flags),
    './details.json': JSON.stringify(details),
  });

  const ufs = new Union();
  ufs.use(realfs).use(memfs);

  await new Promise((resolve, reject) => {
    const compiler = webpack({
      mode: 'production',
      devtool: 'hidden-cheap-source-map',
      entry: isBetaTheme ?
        './webpack/index-core-beta.js' : './webpack/index-core.js',
      output: {
        filename: 'challenges.min.js',
      },
      optimization: {
        minimize: true,
        minimizer: [new TerserPlugin({
          extractComments: {
            condition: 'all',
            banner: () => 'SPDX-License-Identifier: Apache-2.0',
          },
        })],
      },
    });

    compiler.inputFileSystem = compiler.outputFileSystem = ufs;

    compiler.run((err, stats) => {
      console.log(stats.toString({
        colors: true,
      }));

      if (err || stats.hasErrors()) {
        reject(err);
      }
      resolve();
    });
  });

  return await memfs.promises.readFile('dist/challenges.min.js');
};

const detectBetaTheme = function(document) {
  if (IS_CORE_BETA === '1') {
    console.log('$IS_CORE_BETA=1, assuming theme is based on core-beta');
    return true;
  } else if (IS_CORE_BETA === '0') {
    console.log('$IS_CORE_BETA=0, assuming theme is based on core');
    return false;
  } else if (document.querySelector('template')) {
    console.log('Theme seems to be based on core-beta intead of core.');
    console.log('If this is wrong set $IS_CORE_BETA=0');
    return true;
  } else {
    console.log('Theme seems to be based on core intead of core-beta.');
    console.log('If this is wrong set $IS_CORE_BETA=1');
    return false;
  }
};

const writeStaticArchiveShim = async () => {
  const shimPath = PAGES_REPO + STATIC_ARCHIVE_SHIM_PATH;
  await realfs.promises.mkdir(path.dirname(shimPath), {recursive: true});
  await realfs.promises.writeFile(shimPath, STATIC_ARCHIVE_SHIM);
};

const injectScriptTag = (document, src, options = {}) => {
  const existing = Array.from(document.querySelectorAll('script'))
      .find((node) => node.getAttribute('src') === src);
  if (existing) {
    existing.removeAttribute('integrity');
    existing.removeAttribute('crossorigin');
    existing.removeAttribute('data-cf-beacon');
    if (options.defer) {
      existing.setAttribute('defer', '');
    } else {
      existing.removeAttribute('defer');
    }
    existing.type = options.type || existing.type || '';
    return;
  }

  const script = document.createElement('script');
  script.setAttribute('src', src);
  if (options.defer) {
    script.setAttribute('defer', '');
  }
  if (options.type) {
    script.setAttribute('type', options.type);
  }

  const anchor = Array.from(document.querySelectorAll('script[type="module"]'))[0] ||
    Array.from(document.querySelectorAll('script')).at(-1);
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(script, anchor);
  } else {
    document.body.appendChild(script);
  }
};

const updateHtmlFile = async (htmlPath, mutator) => {
  if (!realfs.existsSync(htmlPath)) {
    return;
  }

  const inputhtml = realfs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(inputhtml);
  try {
    await mutator(dom.window.document, inputhtml);
    realfs.writeFileSync(htmlPath, dom.serialize());
  } finally {
    dom.window.close();
  }
};

const main = async function() {
  const challengesHtml = PAGES_REPO + '/challenges.html';
  const scoreboardHtml = PAGES_REPO + '/scoreboard.html';
  const challengesJs = PAGES_REPO + INJECTED_JS_PATH;

  const inputhtml = realfs.readFileSync(challengesHtml, 'utf8');
  const {window} = new JSDOM(inputhtml);
  const {document} = window;

  const isBetaTheme = detectBetaTheme(document);
  window.close();

  const flags = await makeFlagsJson();
  const chalBundled = await makeWebpack(flags, isBetaTheme);
  await realfs.promises.mkdir(
      path.dirname(challengesJs), {recursive: true});
  await realfs.promises.writeFile(challengesJs, chalBundled);
  await writeStaticArchiveShim();

  await updateHtmlFile(challengesHtml, async (doc) => {
    injectScriptTag(doc, STATIC_ARCHIVE_SHIM_PATH);
    injectScriptTag(doc, INJECTED_JS_PATH, {defer: true});
  });
  await updateHtmlFile(scoreboardHtml, async (doc) => {
    injectScriptTag(doc, STATIC_ARCHIVE_SHIM_PATH);
  });

  return 0;
};

if (require.main === module) {
  main().then(process.exit);
}
