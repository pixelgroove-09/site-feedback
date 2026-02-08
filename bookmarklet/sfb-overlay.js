// ============================================
// Site Feedback Overlay — sfb-overlay.js
//
// This script is injected into any webpage via a bookmarklet.
// It adds a floating toolbar that lets users pin comments
// on the page, view existing comments, and manage feedback.
//
// All DOM elements use the "sfb-" prefix to avoid conflicts
// with the host website's styles and scripts.
// ============================================

(function () {
  'use strict';

  // ── Prevent double-loading ──
  // If this script already ran on this page, do nothing.
  if (window.__sfb_loaded) return;
  window.__sfb_loaded = true;

  // ============================================
  // CONFIGURATION
  // Replace YOUR_DOMAIN with your actual Vercel domain.
  // ============================================
  var SUPABASE_URL = 'https://uvodjpfigshthnafkbhg.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_Ap0XV4ppjbqUFhe5KTj5pA_f-S9mAJZ';
  var BASE_URL = getBaseUrl();  // Auto-detect from script src

  // ── App state ──
  // These variables track the current state of the overlay.
  var supabaseClient = null;   // Supabase client instance
  var currentUser = null;      // Currently logged-in user object
  var userProfile = null;      // User's profile (includes role)
  var comments = [];           // Array of comments for the current page
  var pinModeActive = false;   // Is "pin mode" on?
  var sidebarOpen = false;     // Is the sidebar visible?
  var activePopover = null;    // Currently open popover element (or null)
  var pendingPin = null;       // Temporary pin while typing a new comment

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  /**
   * Detect the base URL from where this script was loaded.
   * This allows the bookmarklet to work without hardcoding the domain.
   */
  function getBaseUrl() {
    var scripts = document.querySelectorAll('script[src]');
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].src.indexOf('sfb-overlay.js') !== -1) {
        // Get everything before "/bookmarklet/sfb-overlay.js"
        return scripts[i].src.replace('/bookmarklet/sfb-overlay.js', '');
      }
    }
    // Fallback: current page origin (only works if hosted same-origin)
    return window.location.origin;
  }

  /**
   * Escape HTML to prevent XSS (cross-site scripting) attacks.
   * Any user-generated text must pass through this before being
   * inserted into the page as HTML.
   */
  function escapeHTML(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  /**
   * Format a date string as a human-readable "time ago" string.
   * e.g., "just now", "5m ago", "3h ago", "2d ago"
   */
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

  /**
   * Get the current page URL path, normalized.
   * Removes trailing slashes and converts to lowercase
   * so "/About/" and "/about" are treated as the same page.
   */
  function getPagePath() {
    var path = window.location.pathname.replace(/\/+$/, '') || '/';
    return path.toLowerCase();
  }

  /**
   * Find the nearest meaningful CSS selector for an element.
   * Walks up the DOM tree looking for elements with IDs or
   * semantic HTML tags (section, article, header, etc.)
   */
  function getNearestSelector(element) {
    var el = element;
    while (el && el !== document.body) {
      // Prefer elements with an ID (most specific)
      if (el.id && el.id.indexOf('sfb-') !== 0) {
        return '#' + el.id;
      }
      // Look for semantic HTML elements
      var tag = el.tagName.toLowerCase();
      var semanticTags = ['section', 'article', 'main', 'header', 'footer', 'nav', 'aside'];
      if (semanticTags.indexOf(tag) !== -1) {
        if (el.className && typeof el.className === 'string') {
          // Use the first class name that isn't ours
          var classes = el.className.split(/\s+/);
          for (var i = 0; i < classes.length; i++) {
            if (classes[i] && classes[i].indexOf('sfb-') !== 0) {
              return tag + '.' + classes[i];
            }
          }
        }
        return tag;
      }
      el = el.parentElement;
    }
    return 'body';
  }

  // ============================================
  // SCRIPT & CSS LOADING
  // ============================================

  /**
   * Dynamically load an external JavaScript file.
   * Creates a <script> tag and calls the callback when it finishes loading.
   */
  function loadScript(url, callback) {
    var script = document.createElement('script');
    script.src = url;
    script.onload = callback;
    script.onerror = function () {
      console.error('[Site Feedback] Failed to load script: ' + url);
    };
    document.head.appendChild(script);
  }

  /**
   * Dynamically load the overlay CSS file.
   * Creates a <link> tag and calls the callback when styles are ready.
   */
  function loadCSS(url, callback) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.onload = callback;
    link.onerror = function () {
      console.error('[Site Feedback] Failed to load CSS: ' + url);
      // Still proceed — the UI will look unstyled but functional
      callback();
    };
    document.head.appendChild(link);
  }

  // ============================================
  // INITIALIZATION — Entry point
  // ============================================

  /**
   * Boot sequence:
   * 1. Load CSS
   * 2. Load Supabase JS library
   * 3. Initialize Supabase client
   * 4. Check auth / show login
   * 5. Load comments and render UI
   */
  function boot() {
    console.log('[Site Feedback] Booting... BASE_URL =', BASE_URL);

    // Step 1: Load our CSS (proceed even if it fails)
    loadCSS(BASE_URL + '/bookmarklet/sfb-overlay.css', function () {
      console.log('[Site Feedback] CSS loaded successfully');
      loadSupabaseLib();
    });

    // Safety net: if CSS takes more than 3 seconds, proceed anyway.
    // This handles cases where the CSS file can't be loaded (404, CORS, etc.)
    setTimeout(function () {
      if (!supabaseClient) {
        console.warn('[Site Feedback] CSS load timed out, proceeding without styles');
        loadSupabaseLib();
      }
    }, 3000);
  }

  /**
   * Load the Supabase JS library, then initialize.
   * Separated out so it can be called from boot() or the timeout fallback.
   */
  var _supabaseLoading = false;  // Prevent double-loading
  function loadSupabaseLib() {
    if (_supabaseLoading) return;
    _supabaseLoading = true;

    // Check if Supabase JS is already loaded (in case of double-init)
    if (window.supabase && window.supabase.createClient) {
      console.log('[Site Feedback] Supabase JS already loaded');
      initSupabase();
    } else {
      console.log('[Site Feedback] Loading Supabase JS from CDN...');
      loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', function () {
        console.log('[Site Feedback] Supabase JS loaded');
        initSupabase();
      });
    }
  }

  /**
   * Initialize the Supabase client and check if the user is logged in.
   */
  function initSupabase() {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        // Don't persist sessions in localStorage on this domain.
        // We manage sessions ourselves via the popup.
        persistSession: false
      }
    });

    // Show the login prompt — user must authenticate via popup
    showLoginOverlay();
  }

  // ============================================
  // AUTHENTICATION
  // ============================================

  /**
   * Show a small login card in the bottom-right corner.
   * Clicking the "Sign In" button opens a popup to the auth callback page.
   */
  function showLoginOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'sfb-login';
    overlay.className = 'sfb-login-overlay';
    overlay.innerHTML =
      '<div class="sfb-login-title">Site Feedback</div>' +
      '<div class="sfb-login-subtitle">Sign in to leave feedback on this page</div>' +
      '<button class="sfb-login-btn" id="sfb-login-btn">Sign In with Email</button>' +
      '<button class="sfb-login-close" id="sfb-login-close">Close</button>';
    document.body.appendChild(overlay);

    // "Sign In" button — opens the auth popup
    document.getElementById('sfb-login-btn').addEventListener('click', function () {
      openAuthPopup();
    });

    // "Close" button — removes the overlay entirely
    document.getElementById('sfb-login-close').addEventListener('click', function () {
      removeOverlay();
    });
  }

  /**
   * Open a popup window pointing to our auth callback page.
   * The popup handles the magic link flow and sends the session
   * back to us via postMessage.
   */
  function openAuthPopup() {
    var popupUrl = BASE_URL + '/auth-callback.html';
    var popup = window.open(popupUrl, 'sfb-auth', 'width=420,height=520,left=200,top=200');

    if (!popup) {
      alert('Please allow popups for this site to sign in.');
      return;
    }

    // Listen for the session tokens from the popup.
    // "message" events fire when another window calls postMessage().
    window.addEventListener('message', function handler(event) {
      // Check that this message is from our auth flow
      if (event.data && event.data.type === 'sfb-auth-session') {
        var session = event.data.session;

        // Set the session on our Supabase client.
        // This tells Supabase who we are for all future API calls.
        supabaseClient.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token
        }).then(function (result) {
          if (result.error) {
            console.error('[Site Feedback] Auth error:', result.error.message);
            return;
          }
          currentUser = session.user;

          // Remove the login overlay and start the app
          var loginEl = document.getElementById('sfb-login');
          if (loginEl) loginEl.remove();

          // Remove this listener since we're done with auth
          window.removeEventListener('message', handler);

          // Load the user's profile and start the app
          loadProfileAndStart();
        });
      }
    });
  }

  /**
   * Fetch the user's profile from Supabase (to get their role),
   * then render the toolbar and load existing comments.
   */
  async function loadProfileAndStart() {
    // Query the profiles table for the current user's row
    var result = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();   // .single() returns one object instead of an array

    if (result.error) {
      console.error('[Site Feedback] Profile error:', result.error.message);
      return;
    }

    userProfile = result.data;

    // Now build the UI
    renderToolbar();
    renderSidebar();
    await loadComments();
  }

  // ============================================
  // TOOLBAR
  // ============================================

  /**
   * Create the floating toolbar at the bottom-right of the page.
   * Three buttons: Pin (toggle pin mode), List (show sidebar), Close.
   */
  function renderToolbar() {
    var toolbar = document.createElement('div');
    toolbar.id = 'sfb-toolbar';
    toolbar.className = 'sfb-toolbar';

    // Pin button — toggle pin placement mode
    toolbar.innerHTML =
      '<button class="sfb-toolbar-btn" id="sfb-btn-pin" title="Pin a comment">' +
        // Pin/marker SVG icon
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>' +
          '<circle cx="12" cy="10" r="3"></circle>' +
        '</svg>' +
      '</button>' +

      // List button — open the sidebar
      '<button class="sfb-toolbar-btn" id="sfb-btn-list" title="View all comments">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="8" y1="6" x2="21" y2="6"></line>' +
          '<line x1="8" y1="12" x2="21" y2="12"></line>' +
          '<line x1="8" y1="18" x2="21" y2="18"></line>' +
          '<line x1="3" y1="6" x2="3.01" y2="6"></line>' +
          '<line x1="3" y1="12" x2="3.01" y2="12"></line>' +
          '<line x1="3" y1="18" x2="3.01" y2="18"></line>' +
        '</svg>' +
      '</button>' +

      // Close button — remove the entire overlay
      '<button class="sfb-toolbar-btn" id="sfb-btn-close" title="Close feedback tool">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<line x1="18" y1="6" x2="6" y2="18"></line>' +
          '<line x1="6" y1="6" x2="18" y2="18"></line>' +
        '</svg>' +
      '</button>';

    document.body.appendChild(toolbar);

    // ── Button event handlers ──
    document.getElementById('sfb-btn-pin').addEventListener('click', function () {
      togglePinMode();
    });

    document.getElementById('sfb-btn-list').addEventListener('click', function () {
      toggleSidebar();
    });

    document.getElementById('sfb-btn-close').addEventListener('click', function () {
      removeOverlay();
    });
  }

  // ============================================
  // PIN MODE
  // ============================================

  /**
   * Toggle pin mode on/off.
   * When active, clicking anywhere on the page places a new comment pin.
   */
  function togglePinMode() {
    pinModeActive = !pinModeActive;
    var btn = document.getElementById('sfb-btn-pin');

    if (pinModeActive) {
      btn.classList.add('sfb-active');
      document.body.classList.add('sfb-pin-mode-active');
      closeActivePopover();

      // Add click listener in CAPTURE phase.
      // "Capture" means our handler runs BEFORE the page's own click handlers,
      // so we can intercept clicks without triggering links or buttons.
      document.addEventListener('click', handlePinClick, true);
    } else {
      btn.classList.remove('sfb-active');
      document.body.classList.remove('sfb-pin-mode-active');
      document.removeEventListener('click', handlePinClick, true);
      removePendingPin();
    }
  }

  /**
   * Handle a click while in pin mode.
   * Places a temporary pin and shows the comment text input.
   */
  function handlePinClick(e) {
    // Ignore clicks on our own overlay elements
    if (e.target.closest('#sfb-toolbar') ||
        e.target.closest('.sfb-popover') ||
        e.target.closest('.sfb-new-comment') ||
        e.target.closest('.sfb-sidebar') ||
        e.target.closest('.sfb-pin')) {
      return;
    }

    // Stop the click from reaching the page below (prevents navigating away etc.)
    e.preventDefault();
    e.stopPropagation();

    // Remove any previous pending pin
    removePendingPin();

    // Calculate position:
    // x_percent = horizontal position as % of viewport width
    var xPercent = (e.clientX / window.innerWidth) * 100;
    // y_offset = vertical position from top of the DOCUMENT (not the viewport)
    // pageY already accounts for how far the page is scrolled
    var yOffset = e.pageY;
    // Get CSS selector of the nearest semantic parent element
    var selector = getNearestSelector(e.target);

    // Create a temporary pin marker at the click location
    var tempPin = document.createElement('div');
    tempPin.className = 'sfb-pin';
    tempPin.id = 'sfb-pending-pin';
    tempPin.textContent = '?';
    tempPin.style.left = xPercent + '%';
    tempPin.style.top = yOffset + 'px';
    document.body.appendChild(tempPin);

    // Create the comment input form next to the pin
    var commentForm = document.createElement('div');
    commentForm.className = 'sfb-new-comment';
    commentForm.id = 'sfb-new-comment';
    // Position the form to the right of the pin (or left if near the edge)
    var formLeft = e.clientX + 20;
    if (formLeft + 320 > window.innerWidth) {
      formLeft = e.clientX - 320;
    }
    commentForm.style.left = formLeft + 'px';
    commentForm.style.top = (e.clientY + window.scrollY - 20) + 'px';

    commentForm.innerHTML =
      '<textarea id="sfb-new-comment-text" placeholder="Leave a comment..." autofocus></textarea>' +
      '<div class="sfb-new-comment-actions">' +
        '<button class="sfb-btn sfb-btn-secondary" id="sfb-new-comment-cancel">Cancel</button>' +
        '<button class="sfb-btn sfb-btn-primary" id="sfb-new-comment-save">Save</button>' +
      '</div>';
    document.body.appendChild(commentForm);

    // Focus the textarea
    setTimeout(function() {
      document.getElementById('sfb-new-comment-text').focus();
    }, 50);

    // Store the pin data so we can save it later
    pendingPin = {
      xPercent: xPercent,
      yOffset: yOffset,
      selector: selector
    };

    // Save button
    document.getElementById('sfb-new-comment-save').addEventListener('click', function () {
      saveNewComment();
    });

    // Cancel button
    document.getElementById('sfb-new-comment-cancel').addEventListener('click', function () {
      removePendingPin();
    });

    // Allow pressing Ctrl+Enter or Cmd+Enter to save
    document.getElementById('sfb-new-comment-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        saveNewComment();
      }
      if (e.key === 'Escape') {
        removePendingPin();
      }
    });

    // Turn off pin mode after placing one pin
    pinModeActive = false;
    var btn = document.getElementById('sfb-btn-pin');
    if (btn) btn.classList.remove('sfb-active');
    document.body.classList.remove('sfb-pin-mode-active');
    document.removeEventListener('click', handlePinClick, true);
  }

  /**
   * Remove the temporary pin and comment form.
   */
  function removePendingPin() {
    var pin = document.getElementById('sfb-pending-pin');
    if (pin) pin.remove();
    var form = document.getElementById('sfb-new-comment');
    if (form) form.remove();
    pendingPin = null;
  }

  /**
   * Save the new comment to Supabase and render the pin.
   */
  async function saveNewComment() {
    var textEl = document.getElementById('sfb-new-comment-text');
    var text = textEl ? textEl.value.trim() : '';

    if (!text || !pendingPin) return;

    // Disable the save button while saving
    var saveBtn = document.getElementById('sfb-new-comment-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    // Insert the comment into the Supabase "comments" table
    var result = await supabaseClient
      .from('comments')
      .insert({
        page_url: getPagePath(),
        page_title: document.title,
        x_percent: pendingPin.xPercent,
        y_offset: pendingPin.yOffset,
        selector: pendingPin.selector,
        comment_text: text,
        author_id: currentUser.id
      })
      .select('*, author:profiles!comments_author_id_fkey(email, display_name)')
      .single();   // Return the newly created row

    if (result.error) {
      console.error('[Site Feedback] Save error:', result.error.message);
      alert('Failed to save comment: ' + result.error.message);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
      return;
    }

    // Add the new comment to our local array
    result.data.replies = [];  // New comment has no replies yet
    comments.push(result.data);

    // Remove the temporary pin and form
    removePendingPin();

    // Render the real pin
    renderAllPins();
    updateSidebar();
  }

  // ============================================
  // LOADING & RENDERING COMMENTS
  // ============================================

  /**
   * Fetch all comments for the current page from Supabase.
   * Includes author info and replies (with their authors).
   */
  async function loadComments() {
    var result = await supabaseClient
      .from('comments')
      .select(
        '*, ' +
        'author:profiles!comments_author_id_fkey(email, display_name), ' +
        'resolver:profiles!comments_resolved_by_fkey(email, display_name), ' +
        'replies(*, author:profiles!replies_author_id_fkey(email, display_name))'
      )
      .eq('page_url', getPagePath())
      .order('created_at', { ascending: true });

    if (result.error) {
      console.error('[Site Feedback] Load error:', result.error.message);
      return;
    }

    comments = result.data || [];

    // Sort replies within each comment by date
    comments.forEach(function (comment) {
      if (comment.replies) {
        comment.replies.sort(function (a, b) {
          return new Date(a.created_at) - new Date(b.created_at);
        });
      }
    });

    renderAllPins();
    updateSidebar();
  }

  /**
   * Remove all existing pins from the page and re-render them.
   */
  function renderAllPins() {
    // Remove old pins
    document.querySelectorAll('.sfb-pin:not(#sfb-pending-pin)').forEach(function (el) {
      el.remove();
    });

    // Render each comment as a numbered pin
    comments.forEach(function (comment, index) {
      var pin = document.createElement('div');
      pin.className = 'sfb-pin';
      if (comment.status === 'resolved') {
        pin.classList.add('sfb-pin-resolved');
      }
      pin.setAttribute('data-comment-id', comment.id);
      pin.textContent = index + 1;

      // Position the pin
      pin.style.left = comment.x_percent + '%';
      pin.style.top = comment.y_offset + 'px';

      document.body.appendChild(pin);
    });
  }

  // ============================================
  // POPOVERS — comment detail view
  // ============================================

  /**
   * Event delegation: listen for clicks on pins.
   * "Event delegation" means we have ONE click listener on the body
   * instead of one on each pin. When something is clicked, we check
   * if it was a pin.
   */
  document.body.addEventListener('click', function (e) {
    var pin = e.target.closest('.sfb-pin');
    if (pin && pin.id !== 'sfb-pending-pin') {
      var commentId = pin.getAttribute('data-comment-id');
      if (commentId) {
        e.stopPropagation();
        showPopover(commentId, pin);
      }
    }
  });

  /**
   * Show a popover next to a pin with the comment details.
   */
  function showPopover(commentId, pinElement) {
    closeActivePopover();

    // Find the comment in our local array
    var comment = comments.find(function (c) { return c.id === commentId; });
    if (!comment) return;

    var popover = document.createElement('div');
    popover.className = 'sfb-popover';
    popover.id = 'sfb-active-popover';

    // Position next to the pin
    var pinRect = pinElement.getBoundingClientRect();
    var popLeft = pinRect.right + 12;
    if (popLeft + 340 > window.innerWidth) {
      popLeft = pinRect.left - 340;
    }
    popover.style.left = popLeft + 'px';
    popover.style.top = (pinRect.top + window.scrollY - 10) + 'px';

    // Build the popover content
    var authorName = comment.author ? (comment.author.display_name || comment.author.email) : 'Unknown';
    var statusClass = comment.status === 'open' ? 'sfb-status-open' : 'sfb-status-resolved';

    var html = '';
    html += '<div class="sfb-popover-header">';
    html += '  <span class="sfb-popover-author">' + escapeHTML(authorName) + '</span>';
    html += '  <span class="sfb-popover-time">' + timeAgo(comment.created_at) + '</span>';
    html += '</div>';
    html += '<div class="sfb-popover-text">' + escapeHTML(comment.comment_text) + '</div>';
    html += '<span class="sfb-popover-status ' + statusClass + '">' + comment.status + '</span>';

    // Replies section
    if (comment.replies && comment.replies.length > 0) {
      html += '<div class="sfb-replies">';
      comment.replies.forEach(function (reply) {
        var replyAuthor = reply.author ? (reply.author.display_name || reply.author.email) : 'Unknown';
        html += '<div class="sfb-reply">';
        html += '  <span class="sfb-reply-author">' + escapeHTML(replyAuthor) + '</span>';
        html += '  <span class="sfb-reply-time">' + timeAgo(reply.created_at) + '</span>';
        html += '  <div class="sfb-reply-text">' + escapeHTML(reply.reply_text) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Actions: reply input + buttons
    html += '<div class="sfb-popover-actions">';
    html += '  <input type="text" class="sfb-reply-input" id="sfb-reply-input" placeholder="Write a reply...">';
    html += '  <button class="sfb-btn sfb-btn-primary" id="sfb-reply-send">Reply</button>';
    html += '</div>';

    // Resolve/Reopen button (admin only)
    if (userProfile && userProfile.role === 'admin') {
      if (comment.status === 'open') {
        html += '<div style="margin-top:8px;">';
        html += '  <button class="sfb-btn sfb-btn-resolve" id="sfb-resolve-btn">Resolve</button>';
        html += '</div>';
      } else {
        html += '<div style="margin-top:8px;">';
        html += '  <button class="sfb-btn sfb-btn-reopen" id="sfb-reopen-btn">Reopen</button>';
        html += '</div>';
      }
    }

    popover.innerHTML = html;
    document.body.appendChild(popover);
    activePopover = popover;

    // ── Reply button handler ──
    document.getElementById('sfb-reply-send').addEventListener('click', function () {
      sendReply(commentId);
    });

    // Allow pressing Enter to send reply
    document.getElementById('sfb-reply-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        sendReply(commentId);
      }
    });

    // ── Resolve button handler (if it exists) ──
    var resolveBtn = document.getElementById('sfb-resolve-btn');
    if (resolveBtn) {
      resolveBtn.addEventListener('click', function () {
        resolveComment(commentId);
      });
    }

    // ── Reopen button handler (if it exists) ──
    var reopenBtn = document.getElementById('sfb-reopen-btn');
    if (reopenBtn) {
      reopenBtn.addEventListener('click', function () {
        reopenComment(commentId);
      });
    }

    // Close popover when clicking outside
    setTimeout(function () {
      document.addEventListener('click', handlePopoverOutsideClick);
    }, 10);
  }

  /**
   * Close the popover when clicking outside of it.
   */
  function handlePopoverOutsideClick(e) {
    if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.sfb-pin')) {
      closeActivePopover();
    }
  }

  /**
   * Close and remove the currently open popover.
   */
  function closeActivePopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    document.removeEventListener('click', handlePopoverOutsideClick);
  }

  // ============================================
  // REPLIES
  // ============================================

  /**
   * Send a reply to a comment.
   */
  async function sendReply(commentId) {
    var input = document.getElementById('sfb-reply-input');
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
      console.error('[Site Feedback] Reply error:', result.error.message);
      input.disabled = false;
      return;
    }

    // Add the reply to the local comment object
    var comment = comments.find(function (c) { return c.id === commentId; });
    if (comment) {
      if (!comment.replies) comment.replies = [];
      comment.replies.push(result.data);
    }

    // Re-render the popover to show the new reply
    closeActivePopover();
    var pinEl = document.querySelector('[data-comment-id="' + commentId + '"]');
    if (pinEl) {
      showPopover(commentId, pinEl);
    }
    updateSidebar();
  }

  // ============================================
  // RESOLVE / REOPEN
  // ============================================

  /**
   * Mark a comment as resolved (admin only).
   */
  async function resolveComment(commentId) {
    var result = await supabaseClient
      .from('comments')
      .update({
        status: 'resolved',
        resolved_by: currentUser.id,
        resolved_at: new Date().toISOString()
      })
      .eq('id', commentId);

    if (result.error) {
      console.error('[Site Feedback] Resolve error:', result.error.message);
      return;
    }

    // Update local data
    var comment = comments.find(function (c) { return c.id === commentId; });
    if (comment) {
      comment.status = 'resolved';
      comment.resolved_by = currentUser.id;
      comment.resolved_at = new Date().toISOString();
    }

    closeActivePopover();
    renderAllPins();
    updateSidebar();
  }

  /**
   * Reopen a resolved comment (admin only).
   */
  async function reopenComment(commentId) {
    var result = await supabaseClient
      .from('comments')
      .update({
        status: 'open',
        resolved_by: null,
        resolved_at: null
      })
      .eq('id', commentId);

    if (result.error) {
      console.error('[Site Feedback] Reopen error:', result.error.message);
      return;
    }

    // Update local data
    var comment = comments.find(function (c) { return c.id === commentId; });
    if (comment) {
      comment.status = 'open';
      comment.resolved_by = null;
      comment.resolved_at = null;
    }

    closeActivePopover();
    renderAllPins();
    updateSidebar();
  }

  // ============================================
  // SIDEBAR — list all comments for this page
  // ============================================

  /**
   * Create the sidebar container (hidden initially).
   */
  function renderSidebar() {
    var sidebar = document.createElement('div');
    sidebar.id = 'sfb-sidebar';
    sidebar.className = 'sfb-sidebar';
    sidebar.innerHTML =
      '<div class="sfb-sidebar-header">' +
      '  <span class="sfb-sidebar-title">Comments</span>' +
      '  <button class="sfb-sidebar-close" id="sfb-sidebar-close">&times;</button>' +
      '</div>' +
      '<div class="sfb-sidebar-list" id="sfb-sidebar-list"></div>';
    document.body.appendChild(sidebar);

    document.getElementById('sfb-sidebar-close').addEventListener('click', function () {
      toggleSidebar();
    });
  }

  /**
   * Toggle the sidebar open/closed.
   */
  function toggleSidebar() {
    var sidebar = document.getElementById('sfb-sidebar');
    var btn = document.getElementById('sfb-btn-list');
    if (!sidebar) return;

    sidebarOpen = !sidebarOpen;

    if (sidebarOpen) {
      sidebar.classList.add('sfb-sidebar-open');
      if (btn) btn.classList.add('sfb-active');
      updateSidebar();
    } else {
      sidebar.classList.remove('sfb-sidebar-open');
      if (btn) btn.classList.remove('sfb-active');
    }
  }

  /**
   * Update the sidebar content with the current comments.
   */
  function updateSidebar() {
    var list = document.getElementById('sfb-sidebar-list');
    if (!list) return;

    if (comments.length === 0) {
      list.innerHTML = '<div class="sfb-sidebar-empty">No comments on this page yet.<br>Click the pin icon to add one.</div>';
      return;
    }

    var html = '';
    comments.forEach(function (comment, index) {
      var authorName = comment.author ? (comment.author.display_name || comment.author.email) : 'Unknown';
      var resolvedClass = comment.status === 'resolved' ? ' sfb-resolved' : '';
      var replyCount = comment.replies ? comment.replies.length : 0;

      html += '<div class="sfb-sidebar-item" data-sidebar-comment-id="' + comment.id + '">';
      html += '  <div class="sfb-sidebar-pin-num' + resolvedClass + '">' + (index + 1) + '</div>';
      html += '  <div class="sfb-sidebar-item-content">';
      html += '    <div class="sfb-sidebar-item-text">' + escapeHTML(comment.comment_text) + '</div>';
      html += '    <div class="sfb-sidebar-item-meta">' + escapeHTML(authorName) + ' &middot; ' + timeAgo(comment.created_at);
      if (replyCount > 0) {
        html += ' &middot; ' + replyCount + (replyCount === 1 ? ' reply' : ' replies');
      }
      html += '</div>';
      html += '  </div>';
      html += '</div>';
    });

    list.innerHTML = html;

    // Add click handlers to sidebar items.
    // Clicking a sidebar item scrolls to the pin and opens its popover.
    list.querySelectorAll('.sfb-sidebar-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var commentId = item.getAttribute('data-sidebar-comment-id');
        var pinEl = document.querySelector('[data-comment-id="' + commentId + '"]');
        if (pinEl) {
          // Scroll the pin into view
          pinEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Open the popover after a short delay (for scroll to finish)
          setTimeout(function () {
            showPopover(commentId, pinEl);
          }, 400);
        }
      });
    });
  }

  // ============================================
  // CLEANUP — remove the overlay entirely
  // ============================================

  /**
   * Remove all overlay elements from the page.
   * Called when the user clicks the "Close" button.
   */
  function removeOverlay() {
    // Remove all sfb elements
    var selectors = [
      '#sfb-toolbar', '#sfb-sidebar', '#sfb-login',
      '#sfb-active-popover', '#sfb-pending-pin', '#sfb-new-comment',
      '#sfb-script'
    ];
    selectors.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.remove();
    });

    // Remove all pins
    document.querySelectorAll('.sfb-pin').forEach(function (el) { el.remove(); });

    // Remove pin mode cursor class
    document.body.classList.remove('sfb-pin-mode-active');

    // Remove pin click handler if active
    document.removeEventListener('click', handlePinClick, true);

    // Reset the loaded flag so the bookmarklet can be re-activated
    window.__sfb_loaded = false;
  }

  // ============================================
  // KEYBOARD SHORTCUTS
  // ============================================

  document.addEventListener('keydown', function (e) {
    // Escape key closes popovers, cancels pin mode, closes sidebar
    if (e.key === 'Escape') {
      if (activePopover) {
        closeActivePopover();
      } else if (pendingPin) {
        removePendingPin();
      } else if (pinModeActive) {
        togglePinMode();
      } else if (sidebarOpen) {
        toggleSidebar();
      }
    }
  });

  // ============================================
  // START!
  // ============================================
  boot();

})();
