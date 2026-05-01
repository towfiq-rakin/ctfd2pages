const FLAGS = require('../flags.json');
const DETAILS = require('../details.json');

const sha256sum = async (string) => {
  const utf8 = new TextEncoder().encode(string);
  const hashBuffer = await crypto.subtle.digest('SHA-256', utf8);
  return Array.from(new Uint8Array(hashBuffer))
      .map((bytes) => bytes.toString(16).padStart(2, '0'))
      .join('');
};

exports.submitChallenge = () => async function(chalId, flag) {
  const expectedSHA = FLAGS[chalId];
  const submittedSHA = await sha256sum(flag);

  if (!expectedSHA?.length) {
    return {
      status: 200,
      success: true,
      data: {
        status: 'paused',
        message: 'Flag not archived',
      },
    };
  } else if (expectedSHA.includes(submittedSHA)) {
    return {
      status: 200,
      success: true,
      data: {
        status: 'correct',
        message: 'Correct',
      },
    };
  } else {
    return {
      status: 200,
      success: true,
      data: {
        status: 'incorrect',
        message: 'Incorrect',
      },
    };
  }
};

exports.loadHint = (md, hintsfn) => async function(hintId) {
  for (const hintOrig of hintsfn()) {
    if (hintOrig.id !== hintId) {
      continue;
    }

    const hint = Object.assign({}, hintOrig);
    if (hint.html === undefined) {
      hint.html = md.render(hint.content);
    }

    return {
      status: 200,
      success: true,
      data: hint,
    };
  }

  throw new Error('Hint not found');
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const cleanChallengeName = (value) => String(value || '')
    .replace(/^\[(EASY|MEDIUM|HARD)\]\s*/i, '')
    .trim();

const renderChallengeView = (detail, md) => {
  const descriptionHtml = md.render(detail.description || '');
  const cleanName = cleanChallengeName(detail.name);
  const likes = detail.ratings?.likes || 0;
  const dislikes = detail.ratings?.dislikes || 0;
  const totalRatings = likes + dislikes;
  const likePct = totalRatings ? Math.round((likes / totalRatings) * 100) : 0;
  const filesHtml = detail.files?.length ? `
    <div class="mb-4">
      <div class="d-flex flex-column gap-2 align-items-start">
        ${detail.files.map((file) => `
          <a class="btn btn-outline-dark text-start px-4 py-2" href="${escapeHtml(file.url)}" target="_blank" rel="noopener">
            <i class="fas fa-download me-2"></i>${escapeHtml(file.name)}
          </a>
        `).join('')}
      </div>
    </div>
  ` : '';
  const hintsHtml = detail.hints?.length ? `
    <div class="mb-4">
      <div class="d-flex flex-column gap-2">
        ${detail.hints.map((hint) => `
          <details class="border-0" x-data="Hint" x-init="id = ${hint.id}" @toggle="showHint($event)">
            <summary class="fw-semibold" style="cursor: pointer; list-style: none;">
              <span><i class="fas fa-caret-right me-2"></i>View Hint: ${escapeHtml(hint.title || 'Hint')}</span>
            </summary>
            <div class="pt-2 text-break" x-html="html"></div>
          </details>
        `).join('')}
      </div>
    </div>
  ` : '';
  const connectionHtml = detail.connection_info ? `
    <div class="alert alert-secondary mb-4">
      <div class="fw-bold mb-2">Connection</div>
      <code class="text-break">${escapeHtml(detail.connection_info)}</code>
    </div>
  ` : '';
  const attributionHtml = detail.attribution ? `
    <p class="text-muted mb-3">${escapeHtml(detail.attribution)}</p>
  ` : '';
  const ratingHtml = totalRatings ? `
    <div class="d-flex justify-content-center align-items-center gap-3 text-muted mb-3 small">
      <span><i class="fas fa-thumbs-up me-1"></i>${likes}</span>
      <span>(${likePct}% liked)</span>
      <span><i class="fas fa-thumbs-down me-1"></i>${dislikes}</span>
    </div>
  ` : '';

  return `
    <div class="modal-dialog-centered" :class="getStyles()" x-data="Challenge"
      x-init="
        id = $store.challenge.data.id;
        next_id = $store.challenge.data.next_id;
        max_attempts = $store.challenge.data.max_attempts || 0;
        attempts = $store.challenge.data.attempts || 0;
        tab = 'challenge';
      ">
      <div class="modal-content border-0 shadow-lg" style="border-radius: 0;">
        <div class="modal-header">
          <div class="w-100">
            <div class="d-flex align-items-center justify-content-between mb-3">
              <div class="nav nav-tabs border-0">
                <button type="button" class="nav-link" :class="{active: tab === 'challenge'}" @click="tab = 'challenge'">Challenge</button>
                <button type="button" class="nav-link" :class="{active: tab === 'solves'}" @click="tab = 'solves'; if (!solves.length) { showSolves(); }">
                  <span x-text="($store.challenge.data.solves ?? ${detail.solves || 0}) + ' Solves'"></span>
                </button>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
          </div>
        </div>
        <div class="modal-body">
          <div x-show="tab === 'challenge'">
            <div class="text-center mb-4">
              <h2 class="mb-2">${escapeHtml(cleanName)}</h2>
              <div class="fs-3 fw-bold mb-2">${escapeHtml(detail.value)}</div>
              ${attributionHtml}
              ${ratingHtml}
            </div>
            <div class="challenge-description mb-4">${descriptionHtml}</div>
            ${connectionHtml}
            ${hintsHtml}
            ${filesHtml}
            <form @submit.prevent="submitChallenge()" class="mt-4">
              <div class="input-group gap-3">
                <input id="archived-flag-input" class="form-control" type="text" x-model="submission" placeholder="Flag" autocomplete="off" style="max-width: 420px;">
                <button class="btn btn-outline-dark px-4" type="submit">SUBMIT</button>
              </div>
              <div class="form-text" x-show="max_attempts > 0" x-text="attempts + ' / ' + max_attempts + ' attempts used'"></div>
            </form>
            <template x-if="response">
              <div class="alert mt-3" :class="{
                'alert-success': response.data?.status === 'correct',
                'alert-danger': response.data?.status === 'incorrect',
                'alert-warning': response.data?.status !== 'correct' && response.data?.status !== 'incorrect'
              }" x-text="response.data?.message || 'Archived response'"></div>
            </template>
          </div>
          <div x-show="tab === 'solves'">
            <div class="table-responsive">
              <table class="table align-middle">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="solve in solves" :key="solve.account_id + '-' + solve.date">
                    <tr>
                      <td x-text="solve.name"></td>
                      <td x-text="solve.date"></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
};

exports.displayChallenge = (md) => async function(chalId, cb) {
  const detail = DETAILS[chalId];
  if (!detail) {
    throw new Error(`Challenge ${chalId} not archived`);
  }

  const data = {
    ...detail,
    view: renderChallengeView(detail, md),
  };

  if (window.CTFd?._internal?.challenge) {
    window.CTFd._internal.challenge.data = data;
  } else if (window.CTFd) {
    window.CTFd._internal = window.CTFd._internal || {};
    window.CTFd._internal.challenge = {data};
  }

  cb({data});
};
