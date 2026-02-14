/* ============================================
   RxOnly - Messages Module
   ============================================
   Tapback (reaction) utilities, message item
   building, message list rendering, infinite
   scroll pagination, and message scroll handling.
   ============================================ */

(function() {
  "use strict";

  var R = window.RxOnly;
  var app_state = R.app_state;
  var dom_elements = R.dom_elements;
  var config = R.config;
  var field_maps = R.field_maps;


  /* ------------------------------------------
     Tapback (Reaction) Utilities
     ------------------------------------------ */

  /**
   * In-memory store for tapbacks whose parent message is not yet in the DOM.
   * Keyed by parent message_id (the reply_to value).
   * Value is an array of tapback message data objects.
   * Cleared on view change or "Jump to newest".
   */
  var pending_tapbacks = new Map();

  /**
   * Check if a string consists entirely of emoji characters (1-3 grapheme clusters).
   * Uses Intl.Segmenter for accurate grapheme cluster splitting.
   * @param {string} text - The text to check
   * @returns {boolean}
   */
  function is_emoji_only(text) {
    if (!text) return false;
    var trimmed = text.trim();
    if (trimmed.length === 0) return false;

    // Use Intl.Segmenter for accurate grapheme cluster counting
    var segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    var segments = Array.from(segmenter.segment(trimmed));

    // Allow 1-3 grapheme clusters
    if (segments.length < 1 || segments.length > 3) return false;

    // Verify each segment looks like emoji, not a letter/digit/punctuation
    // Extended_Pictographic covers emoji; Emoji_Component covers modifiers/ZWJ
    var emoji_pattern = /\p{Extended_Pictographic}/u;
    for (var i = 0; i < segments.length; i++) {
      if (!emoji_pattern.test(segments[i].segment)) return false;
    }

    return true;
  }

  /**
   * Check if a message is a tapback (reaction).
   * A tapback is a reply (reply_to is set) whose text is emoji-only.
   * @param {Object} message - Message data from API
   * @returns {boolean}
   */
  function is_tapback(message) {
    return message.reply_to != null && is_emoji_only(message.text);
  }

  /**
   * Clear all pending tapbacks. Call on view change or jump-to-newest.
   */
  function clear_pending_tapbacks() {
    pending_tapbacks.clear();
  }

  /**
   * Store a tapback in the pending map for later attachment.
   * @param {Object} tapback - Tapback message data from API
   */
  function store_pending_tapback(tapback) {
    var parent_id = String(tapback.reply_to);
    if (!pending_tapbacks.has(parent_id)) {
      pending_tapbacks.set(parent_id, []);
    }
    pending_tapbacks.get(parent_id).push(tapback);
  }

  /**
   * Create a tapback pill element for an individual tapback.
   * @param {Object} tapback - Tapback message data
   * @param {boolean} is_dm - Whether this is a DM context
   * @returns {HTMLElement}
   */
  function create_tapback_pill(tapback, is_dm) {
    var pill = document.createElement("a");
    pill.className = "tapback-pill";
    pill.href = R.build_message_url(tapback.message_id, is_dm);
    pill.dataset.tapbackId = String(tapback.message_id);

    var emoji_span = document.createElement("span");
    emoji_span.className = "tapback-emoji";
    emoji_span.textContent = tapback.text.trim();
    pill.appendChild(emoji_span);

    if (tapback.from_node_short_name) {
      var name_span = document.createElement("span");
      name_span.className = "tapback-author";
      name_span.textContent = tapback.from_node_short_name;
      pill.appendChild(name_span);
    }

    return pill;
  }

  /**
   * Create a grouped tapback element (emoji + count, not clickable).
   * @param {string} emoji - The emoji character(s)
   * @param {number} count - Number of this reaction
   * @returns {HTMLElement}
   */
  function create_grouped_tapback(emoji, count) {
    var pill = document.createElement("span");
    pill.className = "tapback-pill tapback-grouped";

    var emoji_span = document.createElement("span");
    emoji_span.className = "tapback-emoji";
    emoji_span.textContent = emoji;
    pill.appendChild(emoji_span);

    var count_span = document.createElement("span");
    count_span.className = "tapback-count";
    count_span.textContent = String(count);
    pill.appendChild(count_span);

    return pill;
  }

  /**
   * Render tapbacks into a parent message's tapback container.
   *
   * Per-emoji grouping: only collapse a specific emoji into a grouped
   * count pill (non-clickable) when there are >5 of that same emoji.
   * Otherwise each tapback is an individual clickable pill.
   *
   * Display cap: show at most 10 pills total. If there are more,
   * append a "+N more" indicator.
   *
   * @param {HTMLElement} container - The .tapback-container element
   * @param {Array} tapbacks - Array of tapback message data
   * @param {boolean} is_dm - Whether this is a DM context
   */
  function render_tapbacks(container, tapbacks, is_dm) {
    container.innerHTML = "";

    if (tapbacks.length === 0) return;

    // Sort by rx_time ascending
    tapbacks.sort(function(a, b) {
      return (a.rx_time || 0) - (b.rx_time || 0);
    });

    // Group tapbacks by emoji text
    var groups = new Map();
    tapbacks.forEach(function(tapback) {
      var emoji = tapback.text.trim();
      if (!groups.has(emoji)) {
        groups.set(emoji, []);
      }
      groups.get(emoji).push(tapback);
    });

    // Build pills: individual for small groups, grouped count for >5 of same emoji
    var pills = [];
    var max_pills = 10;

    groups.forEach(function(group_tapbacks, emoji) {
      if (group_tapbacks.length > 5) {
        // Collapse into a single grouped count pill
        pills.push(create_grouped_tapback(emoji, group_tapbacks.length));
      } else {
        // Individual clickable pills for each tapback
        group_tapbacks.forEach(function(tapback) {
          pills.push(create_tapback_pill(tapback, is_dm));
        });
      }
    });

    // Cap at max_pills, show overflow indicator
    var overflow = pills.length - max_pills;
    var visible_pills = overflow > 0 ? pills.slice(0, max_pills) : pills;

    visible_pills.forEach(function(pill) {
      container.appendChild(pill);
    });

    if (overflow > 0) {
      var more = document.createElement("span");
      more.className = "tapback-pill tapback-overflow";
      more.textContent = "+" + overflow + " more";
      container.appendChild(more);
    }
  }

  /**
   * Attach a tapback to its parent message in the DOM.
   * @param {Object} tapback - Tapback message data
   * @param {boolean} is_dm - Whether this is a DM context
   * @returns {boolean} true if parent was found and tapback attached
   */
  function attach_tapback_to_parent(tapback, is_dm) {
    var parent_id = String(tapback.reply_to);
    var parent_li = document.querySelector(
      '#messages-list li[data-message-id="' + parent_id + '"]'
    );
    if (!parent_li) return false;

    // Get or create the tapback container
    var container = parent_li.querySelector(".tapback-container");
    if (!container) {
      var article = parent_li.querySelector(".message-item");
      if (!article) return false;
      container = document.createElement("div");
      container.className = "tapback-container";
      article.appendChild(container);
    }

    // Collect all tapbacks for this parent (existing + new)
    var existing = [];
    var existing_pills = container.querySelectorAll("[data-tapback-id]");
    existing_pills.forEach(function(pill) {
      existing.push(pill.dataset.tapbackId);
    });

    // Avoid duplicates
    if (existing.indexOf(String(tapback.message_id)) !== -1) return true;

    // Gather all tapback data for this parent to re-render
    // We need the full data, so collect from pending + what's already rendered
    // Simplest approach: store tapback data on the container via a data attribute
    var all_tapbacks = [];
    try {
      var stored = container.dataset.tapbacks;
      if (stored) all_tapbacks = JSON.parse(stored);
    } catch (e) {
      all_tapbacks = [];
    }

    all_tapbacks.push(tapback);
    container.dataset.tapbacks = JSON.stringify(all_tapbacks);

    render_tapbacks(container, all_tapbacks, is_dm);
    return true;
  }

  /**
   * Flush pending tapbacks: attempt to attach any stored tapbacks
   * whose parent messages are now in the DOM.
   * @param {boolean} is_dm - Whether this is a DM context
   */
  function flush_pending_tapbacks(is_dm) {
    if (pending_tapbacks.size === 0) return;

    var resolved_parents = [];

    pending_tapbacks.forEach(function(tapbacks, parent_id) {
      var parent_li = document.querySelector(
        '#messages-list li[data-message-id="' + parent_id + '"]'
      );
      if (parent_li) {
        tapbacks.forEach(function(tapback) {
          attach_tapback_to_parent(tapback, is_dm);
        });
        resolved_parents.push(parent_id);
      }
    });

    // Remove resolved entries from the map
    resolved_parents.forEach(function(parent_id) {
      pending_tapbacks.delete(parent_id);
    });
  }


  /* ------------------------------------------
     Message Item Builder
     ------------------------------------------ */

  /**
   * Format an excerpt for the reply bar.
   * Strips newlines, collapses multiple spaces, and truncates to max_length.
   * Appends an ellipsis if the text was truncated.
   * @param {string} text - The original message text
   * @param {number} max_length - Maximum character count (default 120)
   * @returns {string}
   */
  function format_reply_excerpt(text, max_length) {
    if (!text) return "";
    max_length = max_length || 120;

    // Strip newlines and collapse multiple spaces
    var cleaned = text.replace(/\n/g, " ").replace(/ {2,}/g, " ").trim();

    if (cleaned.length <= max_length) return cleaned;
    return cleaned.substring(0, max_length) + "\u2026";
  }

  /**
   * Create a message list item from message data.
   * Populates the template and sets up node links and message detail links.
   */
  function create_message_item(message, is_dm) {
    var clone = R.populate_template("template-message-item", message, field_maps.message_item);
    if (!clone) return null;

    // Set node link attributes or convert to span for unknown nodes
    var from_link = clone.querySelector(".message-from");
    if (from_link) {
      var has_known_name = message.from_node_long_name || message.from_node_short_name;
      if (has_known_name && message.from_node) {
        from_link.href = R.build_node_url(message.from_node);
        from_link.dataset.nodeId = message.from_node;
      } else {
        // Unknown node — replace <a> with <span>
        var span = document.createElement("span");
        span.className = "message-from node-unknown";
        span.textContent = from_link.textContent;
        from_link.parentNode.replaceChild(span, from_link);
      }
    }

    // Set message detail link
    var time_link = clone.querySelector(".message-time-link");
    if (time_link && message.message_id) {
      time_link.href = R.build_message_url(message.message_id, is_dm);
    }

    // Set datetime attribute on time element
    var time_el = clone.querySelector(".message-time");
    if (time_el && message.rx_time) {
      time_el.setAttribute("datetime", R.format_iso_timestamp(message.rx_time));
    }

    // Populate reply bar for non-tapback replies with parent data
    if (message.reply_to != null && !is_tapback(message) && message.reply_to_text != null) {
      var reply_bar = clone.querySelector(".message-reply-bar");
      if (reply_bar) {
        var author = message.reply_to_from_node_short_name || message.reply_to_from_node || "Unknown";
        var excerpt = format_reply_excerpt(message.reply_to_text);
        var reply_text_el = reply_bar.querySelector(".message-reply-bar-text");
        if (reply_text_el) {
          reply_text_el.innerHTML =
            '<strong class="message-reply-author">Reply to:</strong> ' +
            R.escape_html(author) +
            ' - <em class="message-reply-excerpt">' +
            R.escape_html(excerpt) +
            '</em>';
        }
        reply_bar.href = R.build_message_url(message.reply_to, is_dm);
        reply_bar.dataset.replyToId = String(message.reply_to);
        reply_bar.removeAttribute("hidden");
      }
    }

    // Set li data attributes for cursor tracking and read detection
    var li = clone.querySelector("li");
    if (li) {
      li.dataset.messageId = String(message.message_id);
      if (message.rx_time != null) {
        li.dataset.rxTime = String(message.rx_time);
      }
    }

    return clone;
  }


  /* ------------------------------------------
     Message List Display
     ------------------------------------------ */

  /**
   * Show or hide the "Jump to newest" button based on state.
   */
  function update_jump_to_newest_button() {
    var btn = document.getElementById("jump-to-newest");
    if (!btn) return;
    if (app_state.messages_has_more_newer) {
      btn.removeAttribute("hidden");
    } else {
      btn.setAttribute("hidden", "");
    }
  }

  /**
   * Append message items to the messages list.
   * @param {HTMLElement} messages_ul - The UL element
   * @param {Array} messages - Array of message objects from API
   * @param {boolean} is_dm - Whether these are DMs
   */
  function append_messages_to_list(messages_ul, messages, is_dm) {
    // Separate tapbacks from normal messages
    var normal = [];
    var tapbacks = [];
    messages.forEach(function(message) {
      if (is_tapback(message)) {
        tapbacks.push(message);
      } else {
        normal.push(message);
      }
    });

    // Render normal messages first
    var fragment = document.createDocumentFragment();
    normal.forEach(function(message) {
      var item = create_message_item(message, is_dm);
      if (item) fragment.appendChild(item);
    });
    messages_ul.appendChild(fragment);

    // Now attach tapbacks (parents may be in this batch or already in DOM)
    tapbacks.forEach(function(tapback) {
      if (!attach_tapback_to_parent(tapback, is_dm)) {
        store_pending_tapback(tapback);
      }
    });

    // Flush any previously pending tapbacks whose parents just appeared
    flush_pending_tapbacks(is_dm);
  }

  /**
   * Prepend message items to the messages list and preserve scroll position.
   * Prepended messages are older context — mark them all as read.
   * @param {HTMLElement} messages_ul - The UL element
   * @param {Array} messages - Array of message objects from API (oldest-first)
   * @param {boolean} is_dm - Whether these are DMs
   */
  function prepend_messages_to_list(messages_ul, messages, is_dm) {
    var is_mobile = getComputedStyle(messages_ul).overflowY === "visible";
    var old_scroll_height = is_mobile
      ? document.documentElement.scrollHeight
      : messages_ul.scrollHeight;

    // Separate tapbacks from normal messages
    var normal = [];
    var tapbacks = [];
    messages.forEach(function(message) {
      if (is_tapback(message)) {
        tapbacks.push(message);
      } else {
        normal.push(message);
      }
    });

    // Render normal messages
    var fragment = document.createDocumentFragment();
    normal.forEach(function(message) {
      var item = create_message_item(message, is_dm);
      if (item) fragment.appendChild(item);
    });

    // Mark all prepended items as read (they're older context)
    var prepended_items = fragment.querySelectorAll("li[data-message-id]");
    for (var i = 0; i < prepended_items.length; i++) {
      R.mark_message_read(prepended_items[i]);
    }

    // Prepend before existing content
    messages_ul.insertBefore(fragment, messages_ul.firstChild);

    // Attach tapbacks (parents may be in this batch or already in DOM)
    tapbacks.forEach(function(tapback) {
      if (!attach_tapback_to_parent(tapback, is_dm)) {
        store_pending_tapback(tapback);
      }
    });

    // Flush any previously pending tapbacks whose parents just appeared
    flush_pending_tapbacks(is_dm);

    // Preserve scroll position after prepending content
    var new_scroll_height = is_mobile
      ? document.documentElement.scrollHeight
      : messages_ul.scrollHeight;
    var height_diff = new_scroll_height - old_scroll_height;
    if (is_mobile) {
      window.scrollBy(0, height_diff);
    } else {
      messages_ul.scrollTop += height_diff;
    }
  }

  /**
   * Build the messages list DOM and insert it into main content.
   */
  function render_messages_dom(heading_text, messages, is_dm) {
    var list_content = R.populate_template("template-messages-list", {}, {});
    if (!list_content) return;

    var heading = list_content.querySelector("[data-field='heading']");
    if (heading) heading.textContent = heading_text;

    var messages_ul = list_content.querySelector("#messages-list");
    if (messages_ul) {
      // Messages arrive oldest-first from API (ASC order)
      append_messages_to_list(messages_ul, messages, is_dm);
    }

    dom_elements.main_content.innerHTML = "";
    dom_elements.main_content.appendChild(list_content);

    // Now that the list is in the live DOM, flush any tapbacks
    // whose parents couldn't be found during append (the fragment
    // wasn't in the document yet, so querySelector missed them).
    flush_pending_tapbacks(is_dm);

    // Show/hide "Jump to newest" button
    update_jump_to_newest_button();
  }

  /**
   * Shared logic for loading and displaying messages (channels or DMs).
   * @param {Object} options
   * @param {boolean} options.is_dm
   * @param {number|null} options.channel_index
   * @param {string} options.heading - Display heading text
   */
  async function render_messages_view(options) {
    var is_dm = options.is_dm;
    var channel_index = options.channel_index;
    var heading_text = options.heading;

    R.reset_message_state();
    app_state.messages_is_dm = is_dm;

    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      // Check localStorage for last read position
      var last_read = R.get_last_read(is_dm, channel_index);

      if (last_read) {
        // Resume mode: fetch a page ending at the last-read message,
        // then a page of newer messages after it.
        // Using rx_time + 1 because the API uses strict "rx_time < ?"
        var context_data = await R.fetch_message_page({
          is_dm: is_dm,
          channel_index: channel_index,
          before_rx_time: last_read.rx_time + 1,
        });
        var context_messages = is_dm ? context_data.direct_messages : context_data.messages;

        if (context_messages.length === 0) {
          // Last-read was pruned — fall through to fresh load below
          await render_messages_fresh(is_dm, channel_index, heading_text);
          return;
        }

        // Also fetch a page of newer messages beyond the last-read point
        var newer_data = await R.fetch_message_page({
          is_dm: is_dm,
          channel_index: channel_index,
          after_rx_time: last_read.rx_time,
        });
        var newer_messages = is_dm ? newer_data.direct_messages : newer_data.messages;

        // Combine: context (older + last-read) then newer
        var all_messages = context_messages.concat(newer_messages);

        // Update cursors from both fetches
        R.update_message_cursors(context_data, is_dm);
        R.update_message_cursors(newer_data, is_dm);

        // Use the newer response for has_more_newer since it's the tail
        app_state.messages_has_more_newer = newer_data.meta.has_more_newer;
        // Use the context response for has_more_older since it's the head
        app_state.messages_has_more_older = context_data.meta.has_more_older;

        render_messages_dom(heading_text, all_messages, is_dm);

        // Mark messages up to last-read as read
        var messages_ul = document.getElementById("messages-list");
        if (messages_ul) {
          R.mark_read_up_to(messages_ul, last_read);
        }

        // Restore saved scroll position if returning to the same channel,
        // otherwise scroll to the last-read message.
        var saved_scroll = R.consume_saved_scroll_position(is_dm, channel_index);
        if (saved_scroll !== null && messages_ul) {
          if (saved_scroll.is_mobile) {
            window.scrollTo(0, saved_scroll.scroll_top);
          } else {
            messages_ul.scrollTop = saved_scroll.scroll_top;
          }
        } else {
          scroll_to_last_read(last_read.message_id);
        }

      } else {
        // No last-read: fresh load (newest messages)
        await render_messages_fresh(is_dm, channel_index, heading_text);
      }

    } catch (error) {
      var type_label = is_dm ? "direct messages" : "messages";
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading ' + type_label + ': ' + R.escape_html(error.message) + '</p>';
    }
  }

  /**
   * Fresh load: no last-read position, show the newest messages.
   */
  async function render_messages_fresh(is_dm, channel_index, heading_text) {
    var data = await R.fetch_message_page({
      is_dm: is_dm,
      channel_index: channel_index,
      newest: true,
    });
    var messages = is_dm ? data.direct_messages : data.messages;

    if (messages.length === 0) {
      var empty = R.populate_template("template-messages-empty", {}, {});
      if (empty) {
        var heading = empty.querySelector("[data-field='heading']");
        if (heading) heading.textContent = heading_text;
        dom_elements.main_content.innerHTML = "";
        dom_elements.main_content.appendChild(empty);
      }
      return;
    }

    R.update_message_cursors(data, is_dm);
    render_messages_dom(heading_text, messages, is_dm);

    // For a fresh load, all messages are visible = read. Mark them and
    // save the newest as last-read so the next visit resumes from here.
    var messages_ul = document.getElementById("messages-list");
    if (messages_ul) {
      var items = messages_ul.querySelectorAll("li[data-message-id]");
      for (var i = 0; i < items.length; i++) {
        R.mark_message_read(items[i]);
      }
    }

    if (messages.length > 0) {
      var newest_msg = messages[messages.length - 1];
      R.set_last_read(is_dm, channel_index, newest_msg.message_id, newest_msg.rx_time);
    }

    // Scroll to bottom for fresh load
    if (messages_ul) {
      messages_ul.scrollTop = messages_ul.scrollHeight;
    }
  }

  /**
   * Scroll the messages list so that the last-read message appears
   * at the top of the visible area.
   * @param {number} message_id - The message_id of the last-read message
   */
  function scroll_to_last_read(message_id) {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;

    var target_li = messages_list.querySelector(
      'li[data-message-id="' + message_id + '"]'
    );

    if (target_li) {
      // scrollIntoView with block: "start" puts the element at the top
      // of the scrollable container
      target_li.scrollIntoView({ block: "start" });
    }
  }


  /* ------------------------------------------
     Message View Display
     ------------------------------------------ */

  /**
   * Check if a channel index exists in the sidebar.
   * Returns the channel link element if found, null otherwise.
   */
  function find_sidebar_channel(channel_index) {
    if (!dom_elements.channels_list) return null;
    return dom_elements.channels_list.querySelector(
      '.channel-link[data-channel-index="' + channel_index + '"]'
    );
  }


  async function show_channel_messages(channel_api_url, channel_name, channel_index) {
    // Validate channel exists in sidebar
    if (!find_sidebar_channel(channel_index)) {
      return false;
    }

    R.save_read_position_before_leave();
    app_state.current_view = "channel";
    app_state.current_channel_index = channel_index;
    app_state.current_channel_name = channel_name;
    app_state.current_channel_url = channel_api_url;
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.add("viewing-detail");

    R.clear_sidebar_active();
    var channel_el = find_sidebar_channel(channel_index);
    if (channel_el) channel_el.classList.add("active");

    R.set_breadcrumbs([
      { label: "Dashboard", href: "/", view: "home" },
      { label: channel_name, href: channel_api_url, view: "channel" },
    ]);

    await render_messages_view({
      is_dm: false,
      channel_index: channel_index,
      heading: channel_name,
    });

    return true;
  }

  async function show_direct_messages(dm_api_url) {
    R.save_read_position_before_leave();
    app_state.current_view = "direct_messages";
    app_state.current_channel_index = null;
    app_state.current_channel_name = "Direct Messages";
    app_state.current_channel_url = dm_api_url;
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.add("viewing-detail");

    R.clear_sidebar_active();
    if (dom_elements.channels_list) {
      var dm_el = dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]');
      if (dm_el) dm_el.classList.add("active");
    }

    R.set_breadcrumbs([
      { label: "Dashboard", href: "/", view: "home" },
      { label: "Direct Messages", href: dm_api_url, view: "direct_messages" },
    ]);

    await render_messages_view({
      is_dm: true,
      channel_index: null,
      heading: "Direct Messages",
    });
  }

  async function show_message_detail(message_id, is_dm) {
    R.save_read_position_before_leave();

    // Save previous view context for breadcrumb navigation
    app_state.previous_view = app_state.current_view;
    app_state.previous_channel_index = app_state.current_channel_index;
    app_state.previous_channel_name = app_state.current_channel_name;
    app_state.previous_channel_url = app_state.current_channel_url;

    app_state.current_view = "message";
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.add("viewing-detail");

    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      var url = R.build_message_url(message_id, is_dm);
      var response = await fetch(url);
      var data = await response.json();

      if (!response.ok) {
        var error_msg = data.error || "Message not found";
        R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);
        dom_elements.main_content.innerHTML = '<p class="error-state">' + R.escape_html(error_msg) + '</p>';
        return;
      }

      var crumbs = [{ label: "Dashboard", href: "/", view: "home" }];

      if (app_state.previous_view === "channel" && app_state.previous_channel_name) {
        crumbs.push({
          label: app_state.previous_channel_name,
          href: app_state.previous_channel_url,
          view: "channel",
        });
      } else if (app_state.previous_view === "direct_messages") {
        crumbs.push({
          label: "Direct Messages",
          href: app_state.previous_channel_url,
          view: "direct_messages",
        });
      } else if (is_dm) {
        // Shared DM URL — enrich breadcrumbs with DM context
        var dm_link = dom_elements.channels_list
          ? dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]')
          : null;
        if (dm_link) {
          crumbs.push({
            label: "Direct Messages",
            href: dm_link.getAttribute("href"),
            view: "direct_messages",
          });
        }
      } else if (data.channel_index != null) {
        // Shared message URL — enrich breadcrumbs from API response
        var ch_name = data.channel_name || "Channel " + data.channel_index;
        var ch_link = dom_elements.channels_list
          ? dom_elements.channels_list.querySelector(
              '.channel-link[data-channel-index="' + data.channel_index + '"]'
            )
          : null;
        var ch_href = ch_link ? ch_link.getAttribute("href") : "#";
        crumbs.push({ label: ch_name, href: ch_href, view: "channel" });
      }

      crumbs.push({ label: "Message", href: "#", view: "message" });
      R.set_breadcrumbs(crumbs);

      var content = R.populate_template("template-message-detail", data, field_maps.message_detail);
      if (content) {
        // Set from-node link attributes
        var from_link = content.querySelector(".message-detail-from");
        if (from_link && data.from_node) {
          from_link.href = R.build_node_url(data.from_node);
          from_link.dataset.nodeId = data.from_node;
        }

        // Set reply-to link attributes
        var reply_link = content.querySelector(".message-detail-reply-to");
        if (reply_link && data.reply_to != null) {
          reply_link.href = R.build_message_url(data.reply_to, is_dm);
          reply_link.dataset.replyToId = String(data.reply_to);
        }

        dom_elements.main_content.innerHTML = "";
        dom_elements.main_content.appendChild(content);
      }
    } catch (error) {
      R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading message</p>';
    }
  }


  /* ------------------------------------------
     Message Pagination
     ------------------------------------------ */

  /**
   * Handle "Jump to newest" button click.
   * Clears the DOM, loads the newest page, scrolls to bottom, marks all as read.
   */
  async function handle_jump_to_newest() {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list || app_state.messages_is_loading) return;

    app_state.messages_is_loading = true;
    clear_pending_tapbacks();

    try {
      var is_dm = app_state.messages_is_dm;
      var channel_index = app_state.current_channel_index;

      var data = await R.fetch_message_page({
        is_dm: is_dm,
        channel_index: channel_index,
        newest: true,
      });

      var messages = is_dm ? data.direct_messages : data.messages;

      // Reset cursors for the new page set
      app_state.messages_oldest_rx_time = null;
      app_state.messages_newest_rx_time = null;
      app_state.messages_oldest_id = null;
      app_state.messages_newest_id = null;
      R.update_message_cursors(data, is_dm);

      // Clear and repopulate
      messages_list.innerHTML = "";
      append_messages_to_list(messages_list, messages, is_dm);

      // Mark all messages as read (we just jumped to the newest)
      var all_items = messages_list.querySelectorAll("li[data-message-id]");
      for (var i = 0; i < all_items.length; i++) {
        R.mark_message_read(all_items[i]);
      }

      // Scroll to bottom
      messages_list.scrollTop = messages_list.scrollHeight;

      // Mark the newest message as read
      if (messages.length > 0) {
        var newest_msg = messages[messages.length - 1];
        R.set_last_read(is_dm, channel_index, newest_msg.message_id, newest_msg.rx_time);
      }

      // Update button visibility
      update_jump_to_newest_button();

    } catch (error) {
      console.error("Jump to newest failed:", error);
    } finally {
      app_state.messages_is_loading = false;
    }
  }

  /**
   * Load older messages when scrolling near the top.
   * Prepends them to the list and preserves scroll position.
   */
  async function load_older_messages() {
    if (app_state.messages_is_loading || !app_state.messages_has_more_older) return;
    if (app_state.messages_oldest_rx_time === null) return;

    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;

    app_state.messages_is_loading = true;

    try {
      var is_dm = app_state.messages_is_dm;
      var channel_index = app_state.current_channel_index;

      var data = await R.fetch_message_page({
        is_dm: is_dm,
        channel_index: channel_index,
        before_rx_time: app_state.messages_oldest_rx_time,
      });

      var messages = is_dm ? data.direct_messages : data.messages;

      if (messages.length > 0) {
        // Update has_more_older from this response
        app_state.messages_has_more_older = data.meta.has_more_older;

        // Update oldest cursors
        var first = messages[0];
        app_state.messages_oldest_rx_time = first.rx_time;
        app_state.messages_oldest_id = first.id;

        // Prepend with scroll preservation
        prepend_messages_to_list(messages_list, messages, is_dm);
      } else {
        app_state.messages_has_more_older = false;
      }

    } catch (error) {
      console.error("Load older messages failed:", error);
    } finally {
      app_state.messages_is_loading = false;
    }
  }

  /**
   * Load newer messages when scrolling near the bottom.
   * Appends them to the list.
   */
  async function load_newer_messages() {
    if (app_state.messages_is_loading || !app_state.messages_has_more_newer) return;
    if (app_state.messages_newest_rx_time === null) return;

    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;

    app_state.messages_is_loading = true;

    try {
      var is_dm = app_state.messages_is_dm;
      var channel_index = app_state.current_channel_index;

      var data = await R.fetch_message_page({
        is_dm: is_dm,
        channel_index: channel_index,
        after_rx_time: app_state.messages_newest_rx_time,
      });

      var messages = is_dm ? data.direct_messages : data.messages;

      if (messages.length > 0) {
        app_state.messages_has_more_newer = data.meta.has_more_newer;

        var last = messages[messages.length - 1];
        app_state.messages_newest_rx_time = last.rx_time;
        app_state.messages_newest_id = last.id;

        append_messages_to_list(messages_list, messages, is_dm);
      } else {
        app_state.messages_has_more_newer = false;
      }

      update_jump_to_newest_button();

    } catch (error) {
      console.error("Load newer messages failed:", error);
    } finally {
      app_state.messages_is_loading = false;
    }
  }


  /* ------------------------------------------
     Message Scroll Handling
     ------------------------------------------ */

  function handle_messages_scroll() {
    app_state.messages_scroll_paused = true;

    if (app_state.messages_scroll_timeout) {
      clearTimeout(app_state.messages_scroll_timeout);
    }

    app_state.messages_scroll_timeout = setTimeout(function() {
      app_state.messages_scroll_paused = false;
    }, config.scroll_debounce_delay);

    // Update read position and mark visible messages as read
    R.update_read_position();

    // Load older messages when scrolled near the top
    var messages_list = document.getElementById("messages-list");
    if (messages_list && messages_list.scrollTop < 100) {
      load_older_messages();
    }

    // Load newer messages when scrolled near the last message.
    // Uses last <li> position rather than scrollHeight to ignore the bottom padding.
    if (messages_list) {
      var last_item = messages_list.querySelector("li:last-child");
      if (last_item) {
        var container_rect = messages_list.getBoundingClientRect();
        var item_rect = last_item.getBoundingClientRect();
        if (item_rect.bottom - container_rect.bottom < 200) {
          load_newer_messages();
        }
      }
    }
  }

  /**
   * Mobile message scroll handler.
   * On mobile, .messages-list has overflow-y: visible so scroll events
   * on the list don't fire. Detect window scroll position instead.
   * Called from the global window scroll listener in views.js.
   */
  function handle_messages_window_scroll() {
    // Only act when viewing a messages list (channel or DM)
    if (app_state.current_view !== "channel" && app_state.current_view !== "direct_messages") return;

    // Only act on mobile layout where messages-list doesn't scroll internally
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;
    if (getComputedStyle(messages_list).overflowY !== "visible") return;

    // Pause polling updates during scroll
    app_state.messages_scroll_paused = true;
    if (app_state.messages_scroll_timeout) {
      clearTimeout(app_state.messages_scroll_timeout);
    }
    app_state.messages_scroll_timeout = setTimeout(function() {
      app_state.messages_scroll_paused = false;
    }, config.scroll_debounce_delay);

    // Update read position and mark visible messages as read
    R.update_read_position();

    // Load older messages when the first message is near the viewport top
    var first_item = messages_list.querySelector("li:first-child");
    if (first_item) {
      var first_rect = first_item.getBoundingClientRect();
      if (first_rect.top > -100) {
        load_older_messages();
      }
    }

    // Load newer messages when the last message is near the viewport bottom
    var last_item = messages_list.querySelector("li:last-child");
    if (last_item) {
      var last_rect = last_item.getBoundingClientRect();
      if (last_rect.bottom - window.innerHeight < 200) {
        load_newer_messages();
      }
    }
  }

  function setup_messages_scroll_listener() {
    dom_elements.main_content.addEventListener("scroll", function(event) {
      if (event.target.classList.contains("messages-list")) {
        handle_messages_scroll();
      }
    }, true);

    // "Jump to newest" button click (delegated from main content)
    dom_elements.main_content.addEventListener("click", function(event) {
      var jump_btn = event.target.closest("#jump-to-newest");
      if (jump_btn) {
        event.preventDefault();
        handle_jump_to_newest();
      }
    });
  }


  /* ------------------------------------------
     Namespace Exports
     ------------------------------------------ */

  R.clear_pending_tapbacks = clear_pending_tapbacks;
  R.show_channel_messages = show_channel_messages;
  R.show_direct_messages = show_direct_messages;
  R.show_message_detail = show_message_detail;
  R.append_messages_to_list = append_messages_to_list;
  R.update_jump_to_newest_button = update_jump_to_newest_button;
  R.setup_messages_scroll_listener = setup_messages_scroll_listener;
  R.handle_messages_window_scroll = handle_messages_window_scroll;

})();
