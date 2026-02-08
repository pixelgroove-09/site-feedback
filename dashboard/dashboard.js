// ============================================
// Site Feedback — Admin Dashboard Logic
//
// This script powers the admin dashboard page.
// It handles authentication, fetching comments,
// filtering, replying, resolving, and CSV export.
// ============================================

(function () {
  'use strict';

  // ── Configuration ──
  var SUPABASE_URL = 'https://uvodjpfigshthnafkbhg.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_Ap0XV4ppjbqUFhe5KTj5pA_f-S9mAJZ';

  // ── State ──
  var supabaseClient = null;
  var currentUser = null;
  var userProfile = null;
  var allComments = [];   // All comments fetched from Supabase
  var filtered = [];      // Comments after applying filters

  // ── Initialize Supabase ──
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  /** Escape HTML to prevent XSS attacks. */
  function escapeHTML(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  /** Format a date as "time ago" (e.g., "3h ago"). */
  function timeAgo(dateString) {
    var seconds = Math.floor((new Date() - new Date(dateString)) / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  /** Format a date as a readable string for the CSV. */
  function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // ============================================
  // AUTHENTICATION
  // ============================================

  /**
   * Check if the user is already logged in.
   * If not, show the login form.
   * If yes, load the dashboard.
   */
  async function checkAuth() {
    // Listen for auth changes (e.g., when user clicks a magic link)
    supabaseClient.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_IN' && session) {
        currentUser = session.user;
        loadDashboard();
      }
    });

    // Check for an existing session
    var result = await supabaseClient.auth.getSession();
    if (result.data.session) {
      currentUser = result.data.session.user;
      loadDashboard();
    }
    // If no session, the login form is already visible
  }

  /**
   * Handle the login form submission.
   * Sends a magic link to the user's email.
   */
  var authForm = document.getElementById('auth-form');
  authForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    var email = document.getElementById('auth-email').value.trim();
    var submitBtn = document.getElementById('auth-submit');
    var statusDiv = document.getElementById('auth-status');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    var redirectUrl = window.location.origin + window.location.pathname;

    var result = await supabaseClient.auth.signInWithOtp({
      email: email,
      options: {
        emailRedirectTo: redirectUrl
      }
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Send Magic Link';

    if (result.error) {
      statusDiv.textContent = 'Error: ' + result.error.message;
      statusDiv.className = 'auth-status error';
    } else {
      statusDiv.textContent = 'Check your email for the sign-in link!';
      statusDiv.className = 'auth-status info';
    }
  });

  // ============================================
  // DASHBOARD INITIALIZATION
  // ============================================

  /**
   * Show the dashboard and load all data.
   */
  async function loadDashboard() {
    // Hide login, show dashboard
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';

    // Load user profile to get role
    var profileResult = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();

    if (profileResult.data) {
      userProfile = profileResult.data;
      var infoEl = document.getElementById('user-info');
      infoEl.textContent = (userProfile.display_name || userProfile.email) +
        (userProfile.role === 'admin' ? ' (Admin)' : '');
    }

    // Load comments
    await fetchAllComments();

    // Set up button handlers
    setupButtons();

    // Set up filter handlers
    setupFilters();
  }

  // ============================================
  // DATA FETCHING
  // ============================================

  /**
   * Fetch all comments across all pages from Supabase.
   * This query uses nested selects to also fetch:
   * - The author profile for each comment
   * - The resolver profile (who resolved it)
   * - All replies with their author profiles
   */
  async function fetchAllComments() {
    showLoading(true);

    var result = await supabaseClient
      .from('comments')
      .select(
        '*, ' +
        'author:profiles!comments_author_id_fkey(email, display_name), ' +
        'resolver:profiles!comments_resolved_by_fkey(email, display_name), ' +
        'replies(*, author:profiles!replies_author_id_fkey(email, display_name))'
      )
      .order('created_at', { ascending: true });

    showLoading(false);

    if (result.error) {
      console.error('[Dashboard] Fetch error:', result.error.message);
      return;
    }

    allComments = result.data || [];

    // Sort replies by date within each comment
    allComments.forEach(function (comment) {
      if (comment.replies) {
        comment.replies.sort(function (a, b) {
          return new Date(a.created_at) - new Date(b.created_at);
        });
      }
    });

    // Populate filter dropdowns
    populateFilterOptions();

    // Apply current filters and render
    applyFiltersAndRender();
  }

  // ============================================
  // FILTERING
  // ============================================

  /**
   * Populate the filter dropdown options from the data.
   */
  function populateFilterOptions() {
    // Page filter — unique page URLs
    var pageSelect = document.getElementById('filter-page');
    var currentPageVal = pageSelect.value;  // Preserve current selection
    pageSelect.innerHTML = '<option value="">All pages</option>';

    var pages = {};
    allComments.forEach(function (c) {
      if (!pages[c.page_url]) {
        pages[c.page_url] = c.page_title || c.page_url;
      }
    });
    Object.keys(pages).sort().forEach(function (url) {
      var opt = document.createElement('option');
      opt.value = url;
      opt.textContent = url + (pages[url] !== url ? ' — ' + pages[url] : '');
      pageSelect.appendChild(opt);
    });
    pageSelect.value = currentPageVal;

    // Reviewer filter — unique authors
    var reviewerSelect = document.getElementById('filter-reviewer');
    var currentRevVal = reviewerSelect.value;
    reviewerSelect.innerHTML = '<option value="">All reviewers</option>';

    var reviewers = {};
    allComments.forEach(function (c) {
      if (c.author) {
        reviewers[c.author_id] = c.author.display_name || c.author.email;
      }
    });
    Object.keys(reviewers).forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = reviewers[id];
      reviewerSelect.appendChild(opt);
    });
    reviewerSelect.value = currentRevVal;
  }

  /**
   * Apply filter selections and re-render the comments.
   */
  function applyFiltersAndRender() {
    var pageFilter = document.getElementById('filter-page').value;
    var statusFilter = document.getElementById('filter-status').value;
    var reviewerFilter = document.getElementById('filter-reviewer').value;

    filtered = allComments.filter(function (c) {
      if (pageFilter && c.page_url !== pageFilter) return false;
      if (statusFilter && c.status !== statusFilter) return false;
      if (reviewerFilter && c.author_id !== reviewerFilter) return false;
      return true;
    });

    // Update stats
    var openCount = filtered.filter(function (c) { return c.status === 'open'; }).length;
    var resolvedCount = filtered.filter(function (c) { return c.status === 'resolved'; }).length;
    document.getElementById('filter-stats').textContent =
      filtered.length + ' comment' + (filtered.length !== 1 ? 's' : '') +
      ' (' + openCount + ' open, ' + resolvedCount + ' resolved)';

    renderComments();
  }

  /**
   * Set up filter change handlers.
   */
  function setupFilters() {
    document.getElementById('filter-page').addEventListener('change', applyFiltersAndRender);
    document.getElementById('filter-status').addEventListener('change', applyFiltersAndRender);
    document.getElementById('filter-reviewer').addEventListener('change', applyFiltersAndRender);
  }

  // ============================================
  // RENDERING
  // ============================================

  /**
   * Render all filtered comments, grouped by page URL.
   */
  function renderComments() {
    var container = document.getElementById('comments-container');
    var emptyState = document.getElementById('empty-state');

    if (filtered.length === 0) {
      container.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    // Group comments by page_url
    var groups = {};
    filtered.forEach(function (comment) {
      if (!groups[comment.page_url]) {
        groups[comment.page_url] = {
          title: comment.page_title || comment.page_url,
          comments: []
        };
      }
      groups[comment.page_url].comments.push(comment);
    });

    var html = '';

    // Render each page group
    Object.keys(groups).sort().forEach(function (pageUrl) {
      var group = groups[pageUrl];

      html += '<div class="dash-page-group">';
      html += '  <div class="dash-page-header">';
      html += '    <div>';
      html += '      <span class="dash-page-url">' + escapeHTML(pageUrl) + '</span>';
      if (group.title !== pageUrl) {
        html += '    <span class="dash-page-title">' + escapeHTML(group.title) + '</span>';
      }
      html += '    </div>';
      html += '    <span class="dash-page-count">' + group.comments.length + ' comment' + (group.comments.length !== 1 ? 's' : '') + '</span>';
      html += '  </div>';

      // Render each comment in this group
      group.comments.forEach(function (comment, index) {
        var authorName = comment.author ? (comment.author.display_name || comment.author.email) : 'Unknown';
        var statusClass = comment.status;
        var resolvedClass = comment.status === 'resolved' ? ' resolved' : '';

        html += '<div class="dash-comment' + resolvedClass + '" data-comment-id="' + comment.id + '">';

        // Header row: pin number, author, time, status
        html += '  <div class="dash-comment-header">';
        html += '    <div class="dash-pin-num' + resolvedClass + '">' + (index + 1) + '</div>';
        html += '    <span class="dash-comment-author">' + escapeHTML(authorName) + '</span>';
        html += '    <span class="dash-comment-time">' + timeAgo(comment.created_at) + '</span>';
        html += '    <span class="dash-comment-status ' + statusClass + '">' + comment.status + '</span>';
        html += '  </div>';

        // Comment text
        html += '  <div class="dash-comment-text">' + escapeHTML(comment.comment_text) + '</div>';

        // Replies (if any)
        if (comment.replies && comment.replies.length > 0) {
          html += '<div class="dash-replies">';
          comment.replies.forEach(function (reply) {
            var replyAuthor = reply.author ? (reply.author.display_name || reply.author.email) : 'Unknown';
            html += '<div class="dash-reply">';
            html += '  <span class="dash-reply-author">' + escapeHTML(replyAuthor) + '</span>';
            html += '  <span class="dash-reply-time">' + timeAgo(reply.created_at) + '</span>';
            html += '  <div class="dash-reply-text">' + escapeHTML(reply.reply_text) + '</div>';
            html += '</div>';
          });
          html += '</div>';
        }

        // Actions: reply input + buttons
        html += '<div class="dash-comment-actions">';
        html += '  <input type="text" class="dash-reply-input" placeholder="Write a reply..." data-reply-for="' + comment.id + '">';
        html += '  <button class="dash-btn dash-btn-primary dash-btn-sm" data-reply-btn="' + comment.id + '">Reply</button>';

        // Resolve/Reopen (admin only)
        if (userProfile && userProfile.role === 'admin') {
          if (comment.status === 'open') {
            html += '  <button class="dash-btn dash-btn-resolve dash-btn-sm" data-resolve-btn="' + comment.id + '">Resolve</button>';
          } else {
            html += '  <button class="dash-btn dash-btn-reopen dash-btn-sm" data-reopen-btn="' + comment.id + '">Reopen</button>';
          }
        }

        html += '</div>';  // end actions
        html += '</div>';  // end comment
      });

      html += '</div>';  // end page group
    });

    container.innerHTML = html;

    // Attach event handlers using event delegation.
    // Instead of adding click handlers to each button individually,
    // we listen on the container and check what was clicked.
    container.addEventListener('click', handleCommentAction);

    // Allow pressing Enter to send replies
    container.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches('.dash-reply-input')) {
        var commentId = e.target.getAttribute('data-reply-for');
        sendDashboardReply(commentId);
      }
    });
  }

  /**
   * Handle clicks on comment action buttons (reply, resolve, reopen).
   */
  function handleCommentAction(e) {
    var replyBtn = e.target.closest('[data-reply-btn]');
    if (replyBtn) {
      sendDashboardReply(replyBtn.getAttribute('data-reply-btn'));
      return;
    }

    var resolveBtn = e.target.closest('[data-resolve-btn]');
    if (resolveBtn) {
      resolveFromDashboard(resolveBtn.getAttribute('data-resolve-btn'));
      return;
    }

    var reopenBtn = e.target.closest('[data-reopen-btn]');
    if (reopenBtn) {
      reopenFromDashboard(reopenBtn.getAttribute('data-reopen-btn'));
      return;
    }
  }

  // ============================================
  // ACTIONS: Reply, Resolve, Reopen
  // ============================================

  /**
   * Send a reply to a comment from the dashboard.
   */
  async function sendDashboardReply(commentId) {
    var input = document.querySelector('[data-reply-for="' + commentId + '"]');
    var text = input ? input.value.trim() : '';
    if (!text) return;

    input.disabled = true;

    var result = await supabaseClient
      .from('replies')
      .insert({
        comment_id: commentId,
        reply_text: text,
        author_id: currentUser.id
      })
      .select('*, author:profiles!replies_author_id_fkey(email, display_name)')
      .single();

    if (result.error) {
      console.error('[Dashboard] Reply error:', result.error.message);
      input.disabled = false;
      return;
    }

    // Update local data and re-render
    var comment = allComments.find(function (c) { return c.id === commentId; });
    if (comment) {
      if (!comment.replies) comment.replies = [];
      comment.replies.push(result.data);
    }

    applyFiltersAndRender();
  }

  /**
   * Resolve a comment from the dashboard (admin only).
   */
  async function resolveFromDashboard(commentId) {
    var result = await supabaseClient
      .from('comments')
      .update({
        status: 'resolved',
        resolved_by: currentUser.id,
        resolved_at: new Date().toISOString()
      })
      .eq('id', commentId);

    if (result.error) {
      console.error('[Dashboard] Resolve error:', result.error.message);
      return;
    }

    var comment = allComments.find(function (c) { return c.id === commentId; });
    if (comment) {
      comment.status = 'resolved';
      comment.resolved_by = currentUser.id;
      comment.resolved_at = new Date().toISOString();
    }

    applyFiltersAndRender();
  }

  /**
   * Reopen a resolved comment from the dashboard (admin only).
   */
  async function reopenFromDashboard(commentId) {
    var result = await supabaseClient
      .from('comments')
      .update({
        status: 'open',
        resolved_by: null,
        resolved_at: null
      })
      .eq('id', commentId);

    if (result.error) {
      console.error('[Dashboard] Reopen error:', result.error.message);
      return;
    }

    var comment = allComments.find(function (c) { return c.id === commentId; });
    if (comment) {
      comment.status = 'open';
      comment.resolved_by = null;
      comment.resolved_at = null;
    }

    applyFiltersAndRender();
  }

  // ============================================
  // CSV EXPORT
  // ============================================

  /**
   * Export all filtered comments as a CSV file.
   * The file is generated in the browser and downloaded automatically.
   */
  function exportCSV() {
    if (filtered.length === 0) {
      alert('No comments to export.');
      return;
    }

    // CSV header row
    var headers = ['Page URL', 'Page Title', 'Pin #', 'Comment', 'Author', 'Date', 'Status', 'Replies'];

    // Build rows — one per comment
    // We group by page to generate pin numbers correctly
    var groups = {};
    filtered.forEach(function (c) {
      if (!groups[c.page_url]) groups[c.page_url] = [];
      groups[c.page_url].push(c);
    });

    var rows = [];
    Object.keys(groups).sort().forEach(function (pageUrl) {
      groups[pageUrl].forEach(function (comment, index) {
        var authorName = comment.author ? (comment.author.display_name || comment.author.email) : 'Unknown';

        // Build replies as a single text string
        var repliesText = '';
        if (comment.replies && comment.replies.length > 0) {
          repliesText = comment.replies.map(function (r) {
            var rAuthor = r.author ? (r.author.display_name || r.author.email) : 'Unknown';
            return rAuthor + ': ' + r.reply_text;
          }).join(' | ');
        }

        rows.push([
          csvEscape(comment.page_url),
          csvEscape(comment.page_title || ''),
          index + 1,
          csvEscape(comment.comment_text),
          csvEscape(authorName),
          csvEscape(formatDate(comment.created_at)),
          comment.status,
          csvEscape(repliesText)
        ]);
      });
    });

    // Combine header + rows into CSV text
    var csvContent = headers.map(csvEscape).join(',') + '\n';
    csvContent += rows.map(function (row) { return row.join(','); }).join('\n');

    // Download the CSV file.
    // "Blob" creates a file-like object in memory.
    // We create a temporary download link, click it, and clean up.
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'site-feedback-' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Escape a value for CSV format.
   * Wraps in double quotes if the value contains commas, quotes, or newlines.
   * Double quotes inside the value are escaped by doubling them.
   */
  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    var str = String(value);
    // If the value contains special characters, wrap it in quotes
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ============================================
  // BUTTON SETUP
  // ============================================

  function setupButtons() {
    document.getElementById('btn-export').addEventListener('click', exportCSV);

    document.getElementById('btn-refresh').addEventListener('click', function () {
      fetchAllComments();
    });

    document.getElementById('btn-logout').addEventListener('click', async function () {
      await supabaseClient.auth.signOut();
      // Reload the page to show the login screen
      window.location.reload();
    });
  }

  // ============================================
  // HELPERS
  // ============================================

  function showLoading(visible) {
    document.getElementById('loading-state').style.display = visible ? 'flex' : 'none';
    document.getElementById('comments-container').style.display = visible ? 'none' : 'block';
  }

  // ============================================
  // START
  // ============================================
  checkAuth();

})();
