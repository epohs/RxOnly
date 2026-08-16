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

  /* The three numbers that decide what a reaction is and how a row shows the ones
     it collected. Named here rather than left inline, and gathered rather than
     scattered, because they are maintained by hand in two languages: mesh-console's
     ui/tapbacks.py carries MAX_TAPBACK_CLUSTERS, GROUP_THRESHOLD and MAX_PILLS, and
     each of its comments cites the line of this file it is supposed to match.

     Two of the three had nothing to cite. `3` sat inside a comparison in
     is_emoji_only and `5` inside one in render_tapbacks, so the Python side was
     pointing at magic numbers and a change here would have parted the two silently —
     a reaction grouping one way in a terminal and another in a browser, from the
     same archive. Change one, change the others. */

  // A reaction is one to three emoji. Four is a short message.
  var max_tapback_clusters = 3;

  // More than this many of one emoji collapse into a single count pill, which is
  // then not a link to any one of them.
  var group_threshold = 5;

  // Pills shown before the rest become "+N more".
  var max_pills = 10;

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
    if (segments.length < 1 || segments.length > max_tapback_clusters) return false;

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
   *
   * A tapback is always a reply, so no reply_to settles it immediately. Beyond
   * that the archive may know the answer outright: schema 0.10.0 records the
   * firmware's own emoji flag, and where it is present it wins — it is what the
   * sending client said it was doing, where is_emoji_only() only ever guesses
   * from the text and gets both directions wrong (a deliberate one-emoji reply
   * reads as a reaction; a reaction carrying a word does not).
   *
   * `emoji == null` is the pre-0.10.0 row, whose flag was never recorded and is
   * never backfilled — the heuristic is all there is for those, and it stays for
   * exactly them. Checked with `!= null` rather than truthiness because 0 is a
   * recorded answer meaning "not a reaction", not a missing one.
   *
   * mesh-console's ui/tapbacks.py reimplements this; the two are kept in step by
   * hand and deliberately not shared.
   *
   * @param {Object} message - Message data from API
   * @returns {boolean}
   */
  function is_tapback(message) {
    if (message.reply_to == null) return false;
    if (message.emoji != null) return message.emoji === 1;
    return is_emoji_only(message.text);
  }

  /**
   * Check if a tapback has no parent anywhere in the archive.
   *
   * reply_to_text comes from a LEFT JOIN against the whole `messages` table, not
   * against the page that was loaded — so NULL here does not mean "the parent
   * hasn't been paged in yet", it means the parent is not in the archive at all
   * and no amount of paging will produce it. That is the difference between
   * holding a tapback for later and giving up and drawing it.
   *
   * Parents go missing routinely: a tapback is always newer than what it reacts
   * to, so MAX_MESSAGES pruning removes parents first, and a reaction can also
   * arrive over MQTT for a message this radio never heard.
   *
   * @param {Object} message - Message data from API
   * @returns {boolean}
   */
  function is_orphan_tapback(message) {
    return is_tapback(message) && message.reply_to_text == null;
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

    groups.forEach(function(group_tapbacks, emoji) {
      if (group_tapbacks.length > group_threshold) {
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
    //
    // "Unknown" means there is no sender id to link to, and nothing else. It used
    // to also require a name, from when a node the mesh had never named had no row
    // in the archive and so no page to open — that stopped being true when unnamed
    // nodes started being archived, and the test outlived the reason for it. A
    // nameless sender's page resolves by id and reports what is known about it,
    // which for a beacon heard once is the point of following the link at all.
    var from_link = clone.querySelector(".message-from");
    if (from_link) {
      if (message.from_node) {
        from_link.href = R.build_node_url(message.from_node);
        from_link.dataset.nodeId = message.from_node;
        // A message this device sent, distinguished from one it received — the
        // cue is the sender's own name in a different colour, which is all that
        // is left of mesh-console's three marks for this one fact (see the
        // MessageHeader note in its mesh_console.tcss). Channel rows and DM
        // rows alike, because "yours" is the same fact in both.
        if (message.from_node === R.get_local_node_id()) {
          from_link.classList.add("message-from--outbound");
        }
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

    // An orphan tapback is drawn as an ordinary row, so without this it appears
    // as a bare 💪 from nobody in particular with no hint that it was aimed at
    // something. The note says what the reply bar cannot: the parent is gone, so
    // there is nothing to link to and no excerpt to show.
    //
    // Unhiding is the whole of it — the text is static in the template, where a
    // sentence that never varies belongs, and no href or data-reply-to-id is set
    // because neither has anything to point at.
    if (is_orphan_tapback(message)) {
      var untracked_bar = clone.querySelector(".message-reply-untracked");
      if (untracked_bar) untracked_bar.removeAttribute("hidden");
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
   * Split a batch into messages that get drawn and tapbacks that get attached.
   *
   * Orphans go in `normal`, which is the whole of the fix for "Primary (1) and
   * an empty channel": a tapback whose parent is not in the archive can never be
   * attached to anything, so leaving it in `tapbacks` meant it was held forever
   * and drawn nowhere while the sidebar went on counting it.
   *
   * Shared by both callers so the two cannot drift — they had identical copies
   * of this, and identical is what they have to stay.
   *
   * @param {Array} messages - Array of message objects from API
   * @returns {{normal: Array, tapbacks: Array}}
   */
  function partition_tapbacks(messages) {
    var normal = [];
    var tapbacks = [];
    messages.forEach(function(message) {
      if (is_tapback(message) && !is_orphan_tapback(message)) {
        tapbacks.push(message);
      } else {
        normal.push(message);
      }
    });
    return { normal: normal, tapbacks: tapbacks };
  }

  /**
   * Append message items to the messages list.
   * @param {HTMLElement} messages_ul - The UL element
   * @param {Array} messages - Array of message objects from API
   * @param {boolean} is_dm - Whether these are DMs
   */
  function append_messages_to_list(messages_ul, messages, is_dm) {
    var split = partition_tapbacks(messages);
    var normal = split.normal;
    var tapbacks = split.tapbacks;

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

    var split = partition_tapbacks(messages);
    var normal = split.normal;
    var tapbacks = split.tapbacks;

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
   * Shared logic for loading and displaying messages (channels or conversations).
   * @param {Object} options
   * @param {boolean} options.is_dm
   * @param {number|null} options.channel_index
   * @param {string|null} [options.peer] - The conversation's peer (DMs only)
   * @param {string} options.heading - Display heading text
   */
  async function render_messages_view(options) {
    var is_dm = options.is_dm;
    var channel_index = options.channel_index;
    var peer = options.peer || null;
    var heading_text = options.heading;

    R.reset_message_state();

    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      // Check localStorage for last read position
      var last_read = R.get_last_read(is_dm, channel_index, peer);

      if (last_read) {
        // Resume mode: fetch a page ending at the last-read message,
        // then a page of newer messages after it.
        // Using rx_time + 1 because the API uses strict "rx_time < ?"
        var context_data = await R.fetch_message_page({
          is_dm: is_dm,
          channel_index: channel_index,
          peer: peer,
          before_rx_time: last_read.rx_time + 1,
        });
        var context_messages = is_dm ? context_data.direct_messages : context_data.messages;

        if (context_messages.length === 0) {
          // Last-read was pruned — fall through to fresh load below
          await render_messages_fresh(is_dm, channel_index, peer, heading_text);
          return;
        }

        // Also fetch a page of newer messages beyond the last-read point
        var newer_data = await R.fetch_message_page({
          is_dm: is_dm,
          channel_index: channel_index,
          peer: peer,
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
        // otherwise position the first unread message at the read threshold.
        var saved_scroll = R.consume_saved_scroll_position(is_dm, channel_index, peer);
        if (saved_scroll !== null && messages_ul) {
          if (saved_scroll.is_mobile) {
            window.scrollTo(0, saved_scroll.scroll_top);
          } else {
            messages_ul.scrollTop = saved_scroll.scroll_top;
          }
        } else {
          scroll_to_first_unread_at_threshold();
        }

      } else {
        // No last-read: fresh load (oldest messages first)
        await render_messages_fresh(is_dm, channel_index, peer, heading_text);
      }

    } catch (error) {
      var type_label = is_dm ? "direct messages" : "messages";
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading ' + type_label + ': ' + R.escape_html(error.message) + '</p>';
    }
  }

  /**
   * Fresh load: no last-read position, show the newest messages.
   */
  async function render_messages_fresh(is_dm, channel_index, peer, heading_text) {
    // No last-read position: load from the oldest messages so the user
    // can read the channel from the beginning. Nothing is pre-marked as read;
    // the user marks messages read by scrolling past the threshold.
    var data = await R.fetch_message_page({
      is_dm: is_dm,
      channel_index: channel_index,
      peer: peer,
    });
    var messages = is_dm ? data.direct_messages : data.messages;

    if (messages.length === 0) {
      show_messages_empty_state(heading_text);
      return;
    }

    R.update_message_cursors(data, is_dm);
    render_messages_dom(heading_text, messages, is_dm);

    // **Rows returned is not rows drawn.** The check above asks the API how many
    // messages there are; every tapback in the batch whose parent is not in it
    // is held back for a later page, so a batch can be non-empty and still put
    // nothing on the screen — which is what produced a heading over an empty
    // list where mesh-console, testing the same thing differently, said "No
    // messages in this channel."
    //
    // Only when there is no further page to fetch. With more pages the held
    // tapbacks may still find their parents, and an empty state that resolves
    // itself a second later is worse than a blank moment.
    if (!app_state.messages_has_more_older && !app_state.messages_has_more_newer) {
      var messages_ul = document.getElementById("messages-list");
      if (messages_ul && messages_ul.querySelectorAll("li[data-message-id]").length === 0) {
        show_messages_empty_state(heading_text);
      }
    }

    // Scroll position is left at the top; "Jump to newest" button will appear
    // automatically if there are newer pages (messages_has_more_newer = true).
  }

  /**
   * Replace main content with the "no messages" template under `heading_text`.
   */
  function show_messages_empty_state(heading_text) {
    var empty = R.populate_template("template-messages-empty", {}, {});
    if (!empty) return;

    var heading = empty.querySelector("[data-field='heading']");
    if (heading) heading.textContent = heading_text;
    dom_elements.main_content.innerHTML = "";
    dom_elements.main_content.appendChild(empty);
  }

  /**
   * Scroll the messages list so that the first unread message appears
   * at the read threshold line (1/3 up from the bottom of the visible area).
   * This lets the user see some unread messages immediately on return,
   * matching the same position where messages will be marked as read.
   *
   * Falls back to the last message if all messages are already read.
   */
  function scroll_to_first_unread_at_threshold() {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;

    var all_items = messages_list.querySelectorAll("li[data-message-id]");
    if (all_items.length === 0) return;

    // Find the first item not yet marked read
    var target = null;
    for (var i = 0; i < all_items.length; i++) {
      if (!all_items[i].classList.contains("message-read")) {
        target = all_items[i];
        break;
      }
    }

    // Fall back to the last item if everything is already read
    if (!target) {
      target = all_items[all_items.length - 1];
    }

    var is_mobile = getComputedStyle(messages_list).overflowY === "visible";
    var ratio = R.config.read_threshold_ratio;

    if (is_mobile) {
      // offsetTop is relative to the document on mobile
      var scroll_top = target.offsetTop - window.innerHeight * (1 - ratio);
      window.scrollTo(0, Math.max(0, scroll_top));
    } else {
      var scroll_top = target.offsetTop - messages_list.clientHeight * (1 - ratio);
      messages_list.scrollTop = Math.max(0, scroll_top);
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
    app_state.current_peer = null;
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

  /* ------------------------------------------
     Direct Messages (Conversation Index)
     ------------------------------------------ */

  /**
   * The peer's short name, or the hex id when the archive has no name for them.
   * Short name alone rather than the full display name, for the reason
   * mesh-console's ConversationItem gives: this is a list of people you have
   * talked to, not a destination about to be addressed.
   */
  function conversation_peer_label(conversation) {
    return conversation.peer_short_name || conversation.peer;
  }

  /**
   * This device's short name, for the left-hand side of a row's title. Falls
   * back through the long name to the hex id the way every other node label
   * does — and to "You" when the server sent no local node at all, which is
   * also the case where there are no conversations to draw under it.
   */
  function conversation_local_label(local_node) {
    if (!local_node) return "You";
    return local_node.short_name || local_node.long_name || local_node.node_id;
  }

  /**
   * "8/14 11:17 AM · 3 messages", each part left out when it has nothing to say.
   * No unread count on the end where mesh-console has one: it counts unread
   * server-side from cursors it owns, and this browser's read state never
   * reaches the server — unread here is the row's bold cue, a yes or no, which
   * is all this interface has ever said about unread anywhere.
   */
  function format_conversation_summary(conversation) {
    var count = conversation.message_count || 0;
    var count_text = count + " message" + (count !== 1 ? "s" : "");
    var time = R.format_time_short(conversation.newest_rx_time);
    return time ? time + " · " + count_text : count_text;
  }

  /**
   * Whether a conversation row gets the unread bold, from the row's own data.
   * The same comparison the sidebar makes (has_unread in views.js, called at
   * runtime like refresh_channel_unread is from rxonly.js), fed the conversation
   * payload's newest inbound drawn rx_time instead of the stats map — the two
   * report the same figure from the same query shape.
   */
  function conversation_has_unread(conversation) {
    var last_read = R.get_last_read(true, null, conversation.peer);
    return R.has_unread(conversation.newest_inbound_rx_time, last_read);
  }

  /**
   * Create a conversation index row from one conversations-payload entry.
   * Built by hand rather than through a field map because every part of both
   * lines is computed from more than one field.
   */
  function create_conversation_item(conversation, local_label) {
    var clone = R.populate_template("template-conversation-item", {}, {});
    if (!clone) return null;

    var link = clone.querySelector(".conversation-link");
    if (!link) return null;

    // The API url as the href, like every channel and node link — the click is
    // intercepted into the hash router, and without JS the link still resolves
    // to the thread's JSON.
    link.href = R.get_direct_messages_url() + "?peer=" + encodeURIComponent(conversation.peer);
    link.dataset.peer = conversation.peer;
    link.classList.toggle("unread", conversation_has_unread(conversation));

    var title = link.querySelector(".conversation-title");
    if (title) {
      title.textContent = local_label + " › " + conversation_peer_label(conversation);
    }

    var summary = link.querySelector(".conversation-summary");
    if (summary) {
      summary.textContent = format_conversation_summary(conversation);
    }

    return clone;
  }

  /**
   * Build the conversation index DOM and insert it into main content.
   */
  function render_conversations_dom(data) {
    var list_content = R.populate_template("template-conversations-list", {}, {});
    if (!list_content) return;

    var heading = list_content.querySelector("[data-field='heading']");
    if (heading) heading.textContent = "Direct Messages";

    var conversations_ul = list_content.querySelector("#conversations-list");
    if (conversations_ul) {
      var local_label = conversation_local_label(data.local_node);
      var fragment = document.createDocumentFragment();

      data.conversations.forEach(function(conversation) {
        var item = create_conversation_item(conversation, local_label);
        if (item) fragment.appendChild(item);
      });

      if (data.conversations.length === 0) {
        var empty_li = document.createElement("li");
        empty_li.className = "empty-state";
        empty_li.textContent = "No direct messages";
        fragment.appendChild(empty_li);
      }

      conversations_ul.appendChild(fragment);
    }

    dom_elements.main_content.innerHTML = "";
    dom_elements.main_content.appendChild(list_content);
  }

  /**
   * Refresh the conversation index in place from the slow poll.
   *
   * The same rebuild-with-reuse update_nodes_list does, keyed by peer: rows that
   * are still here are updated and re-appended in the fresh order — recency, and
   * a message arriving is exactly what moves somebody up it — new peers get new
   * rows, and rows whose peer dropped out are simply not carried over. Scroll is
   * anchored the same way, so a reader partway down the list is not yanked.
   */
  async function update_conversations_list() {
    var conversations_ul = document.getElementById("conversations-list");
    if (!conversations_ul) return;

    try {
      var data = await R.fetch_conversations();
      var local_label = conversation_local_label(data.local_node);

      var was_at_top = R.is_at_scroll_top(conversations_ul);
      var anchor = was_at_top ? null : R.get_scroll_anchor(conversations_ul);

      var existing_items = {};
      conversations_ul.querySelectorAll("li").forEach(function(li) {
        var link = li.querySelector(".conversation-link");
        if (link) existing_items[link.dataset.peer] = li;
      });

      var fragment = document.createDocumentFragment();

      data.conversations.forEach(function(conversation) {
        var li = existing_items[conversation.peer];
        if (li) {
          var link = li.querySelector(".conversation-link");
          var title = li.querySelector(".conversation-title");
          var summary = li.querySelector(".conversation-summary");
          // The title is re-said even when nothing else moved, because its
          // left half is the local node's short name, which arrives late on a
          // fresh archive — the same reason mesh-console's set_conversation
          // always updates it.
          if (title) title.textContent = local_label + " › " + conversation_peer_label(conversation);
          if (summary) summary.textContent = format_conversation_summary(conversation);
          if (link) link.classList.toggle("unread", conversation_has_unread(conversation));
          fragment.appendChild(li);
        } else {
          var item = create_conversation_item(conversation, local_label);
          if (item) fragment.appendChild(item);
        }
      });

      if (data.conversations.length === 0) {
        var empty_li = document.createElement("li");
        empty_li.className = "empty-state";
        empty_li.textContent = "No direct messages";
        fragment.appendChild(empty_li);
      }

      conversations_ul.innerHTML = "";
      conversations_ul.appendChild(fragment);

      if (was_at_top) {
        conversations_ul.scrollTop = 0;
      } else if (anchor) {
        R.restore_scroll_anchor(conversations_ul, anchor);
      }

    } catch (error) {
      console.error("Failed to update conversations list:", error);
    }
  }

  /**
   * Show the direct message index: who this device has talked to, one row per
   * person, in place of the flat all-conversations-at-once list this view used
   * to be. Each row opens that peer's thread through show_conversation.
   */
  async function show_direct_messages(dm_api_url) {
    R.save_read_position_before_leave();
    app_state.current_view = "direct_messages";
    app_state.current_channel_index = null;
    app_state.current_channel_name = "Direct Messages";
    app_state.current_channel_url = dm_api_url;
    app_state.current_peer = null;
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.add("viewing-detail");

    // Nothing here is a message, so nothing here is paged. Cleared rather than
    // left holding whatever thread was open last, so a stale has_more_newer
    // cannot leave the jump button pointing at somewhere this view cannot go —
    // mesh-console's open_direct_index clears its window state for the same
    // reason.
    R.reset_message_state();

    R.clear_sidebar_active();
    if (dom_elements.channels_list) {
      var dm_el = dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]');
      if (dm_el) dm_el.classList.add("active");
    }

    R.set_breadcrumbs([
      { label: "Dashboard", href: "/", view: "home" },
      { label: "Direct Messages", href: dm_api_url, view: "direct_messages" },
    ]);

    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      var data = await R.fetch_conversations();
      render_conversations_dom(data);
    } catch (error) {
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading direct messages: ' + R.escape_html(error.message) + '</p>';
    }
  }

  /**
   * Show one conversation: the direct messages with one peer, and nobody else.
   * The same message-list machinery a channel uses — resume window, read
   * threshold, pagination, jump button — pointed at one thread.
   */
  async function show_conversation(peer) {
    R.save_read_position_before_leave();

    // Resolve the peer's display name before anything renders, the way
    // mesh-console's open_conversation does. A node the archive cannot name
    // still has a thread worth opening; the hex id is a serviceable heading.
    var heading_text = peer;
    try {
      var node_response = await fetch(R.build_node_url(peer));
      if (node_response.ok) {
        var node = await node_response.json();
        heading_text = R.format_node_display_name(node);
      }
    } catch (error) {
      // Leave the hex id standing.
    }

    var thread_url = R.get_direct_messages_url() + "?peer=" + encodeURIComponent(peer);

    app_state.current_view = "conversation";
    app_state.current_channel_index = null;
    app_state.current_channel_name = heading_text;
    app_state.current_channel_url = thread_url;
    app_state.current_peer = peer;
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.add("viewing-detail");

    // The sidebar has no entry for one conversation; its Direct Messages entry
    // is the nearest ancestor, so it keeps the active mark and the breadcrumbs
    // carry the rest of the way — the reasoning mesh-console gives for its
    // conversation trail.
    R.clear_sidebar_active();
    var dm_href = "#";
    if (dom_elements.channels_list) {
      var dm_el = dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]');
      if (dm_el) {
        dm_el.classList.add("active");
        dm_href = dm_el.getAttribute("href");
      }
    }

    R.set_breadcrumbs([
      { label: "Dashboard", href: "/", view: "home" },
      { label: "Direct Messages", href: dm_href, view: "direct_messages" },
      { label: heading_text, href: thread_url, view: "conversation" },
    ]);

    await render_messages_view({
      is_dm: true,
      channel_index: null,
      peer: peer,
      heading: heading_text,
    });
  }

  async function show_message_detail(message_id, is_dm) {
    R.save_read_position_before_leave();

    // Save previous view context for breadcrumb navigation
    app_state.previous_view = app_state.current_view;
    app_state.previous_channel_index = app_state.current_channel_index;
    app_state.previous_channel_name = app_state.current_channel_name;
    app_state.previous_channel_url = app_state.current_channel_url;
    app_state.previous_peer = app_state.current_peer;

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
      } else if (app_state.previous_view === "conversation" && app_state.previous_channel_name) {
        // A detail reached from inside a thread walks back through both steps:
        // the index of correspondents, then the thread itself.
        var index_link = dom_elements.channels_list
          ? dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]')
          : null;
        crumbs.push({
          label: "Direct Messages",
          href: index_link ? index_link.getAttribute("href") : "#",
          view: "direct_messages",
        });
        crumbs.push({
          label: app_state.previous_channel_name,
          href: app_state.previous_channel_url,
          view: "conversation",
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

    var conversation = R.current_conversation();
    if (!conversation) return;

    app_state.messages_is_loading = true;
    clear_pending_tapbacks();

    try {
      var is_dm = conversation.is_dm;
      var channel_index = conversation.channel_index;

      var data = await R.fetch_message_page({
        is_dm: is_dm,
        channel_index: channel_index,
        peer: conversation.peer,
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

      // Jumping to the newest page is reading to the end, so the position goes to the
      // end — the ceiling the sidebar compares against, not the newest row of the
      // batch. `messages` here is the raw batch, folded reactions and all, so its last
      // entry is not necessarily a row that was drawn; taking the ceiling makes this
      // agree with the bottom-grace block in update_read_position, which reaches the
      // same state by scrolling.
      //
      // Through advance_last_read like every other write, which is what stops this
      // dragging a position *backwards* — it used to call set_last_read outright, so
      // a jump landing on an older page moved the mark the wrong way. And the sidebar
      // is refreshed here, because nothing else will until the next fast poll: the
      // channel stayed bold for up to ten seconds after being read to the end.
      if (messages.length > 0) {
        var newest_msg = messages[messages.length - 1];
        var newest_rx_time = newest_msg.rx_time;
        var ceiling = R.get_unread_ceiling(is_dm, channel_index, conversation.peer);
        if (ceiling !== null && ceiling > newest_rx_time) {
          newest_rx_time = ceiling;
        }
        if (R.advance_last_read(is_dm, channel_index, conversation.peer, newest_msg.message_id, newest_rx_time)) {
          R.refresh_channel_unread();
        }
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

    var conversation = R.current_conversation();
    if (!conversation) return;

    app_state.messages_is_loading = true;

    try {
      var is_dm = conversation.is_dm;
      var channel_index = conversation.channel_index;

      var data = await R.fetch_message_page({
        is_dm: is_dm,
        channel_index: channel_index,
        peer: conversation.peer,
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

    var conversation = R.current_conversation();
    if (!conversation) return;

    app_state.messages_is_loading = true;

    try {
      var is_dm = conversation.is_dm;
      var channel_index = conversation.channel_index;

      var data = await R.fetch_message_page({
        is_dm: is_dm,
        channel_index: channel_index,
        peer: conversation.peer,
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
    // Only act when viewing a messages list (channel or conversation)
    if (app_state.current_view !== "channel" && app_state.current_view !== "conversation") return;

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
  R.show_conversation = show_conversation;
  R.update_conversations_list = update_conversations_list;
  R.show_message_detail = show_message_detail;
  R.append_messages_to_list = append_messages_to_list;
  R.update_jump_to_newest_button = update_jump_to_newest_button;
  R.setup_messages_scroll_listener = setup_messages_scroll_listener;
  R.handle_messages_window_scroll = handle_messages_window_scroll;

})();
