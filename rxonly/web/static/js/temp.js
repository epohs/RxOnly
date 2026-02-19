/* ============================================
   RxOnly - Core Application Module
   ============================================
   Configuration, global state, DOM references,
   utility functions, template engine, field maps,
   scroll preservation, read tracking, API layer,
   and breadcrumb navigation.
   ============================================ */

(function() {
  "use strict";

  var RxOnly = window.RxOnly = {};


  /* ------------------------------------------
     Configuration
     ------------------------------------------ */

  var config = {
    fast_poll_interval: 10000,    // 10 seconds
    slow_poll_interval: 20000,    // 20 seconds
    scroll_debounce_delay: 2000,  // 2 seconds after scroll stops
    max_poll_failures: 3,         // Show error after this many failures
    search_debounce_delay: 300,   // 300ms debounce for search
  };


  /* ------------------------------------------
     State
     ------------------------------------------ */

  var app_state = {
    current_view: "home",  // "home", "channel", "node", "direct_messages", "message"
    current_channel_index: null,
    current_channel_name: null,
    current_channel_url: null,
    current_node_url: null,
    breadcrumbs: [{ label: "Dashboard", href: "/", view: "home" }],
    is_loading_more_nodes: false,

    // Previous view context (for breadcrumb navigation)
    previous_view: null,
    previous_channel_index: null,
    previous_channel_name: null,
    previous_channel_url: null,

    // Polling state
    fast_poll_timer: null,
    slow_poll_timer: null,
    poll_failure_count: 0,
    known_local_node_id: null,
    known_first_seen: null,

    // Scroll debounce state
    nodes_scroll_timeout: null,
    nodes_scroll_paused: false,
    messages_scroll_timeout: null,
    messages_scroll_paused: false,

    // Cursor-based message pagination state
    messages_has_more_older: false,
    messages_has_more_newer: false,
    messages_is_loading: false,
    messages_oldest_rx_time: null,
    messages_newest_rx_time: null,
    messages_oldest_id: null,
    messages_newest_id: null,
    messages_is_dm: false,
    messages_total: 0,

    // Nodes search state
    nodes_search_query: "",
    nodes_search_debounce_timeout: null,
    nodes_search_request_id: 0,
    total_nodes: 0,
    cached_local_node_name: null,

    // Scroll position preservation
    saved_messages_scroll_top: null,
    saved_messages_is_mobile: false,
    saved_messages_channel_index: null,
    saved_messages_is_dm: false,

    // Hash routing state
    navigating_from_content: false,

    // Breadcrumb reveal state (mobile scroll-up detection)
    breadcrumb_last_scroll_y: 0,
    breadcrumb_scroll_up_distance: 0,
    breadcrumb_is_sticky: false,
  };


  /* ------------------------------------------
     DOM References
     ------------------------------------------ */

  var dom_elements = {
    body: document.body,
    app_layout: document.querySelector(".app-layout"),
    breadcrumbs_list: document.querySelector(".breadcrumbs ol"),
    main_content: document.getElementById("main-content"),
    nodes_list: document.querySelector(".nodes-list"),
    nodes_count: document.querySelector(".node-count"),
    channels_list: document.querySelector(".channels-list"),
    nodes_list_heading: document.getElementById("nodes-heading"),
    nodes_search_input: document.getElementById("nodes-search-input"),
    nodes_search_clear: document.getElementById("nodes-search-clear"),
  };


  /* ------------------------------------------
     Utility Functions
     ------------------------------------------ */

  function get_node_name_from_data(local_node) {
    if (!local_node) {
      return "";
    }
    if (local_node.long_name) {
      return local_node.long_name;
    }
    if (local_node.short_name) {
      return local_node.short_name;
    }
    if (local_node.node_id) {
      return local_node.node_id;
    }
    return "";
  }

  function update_page_title(stats_data) {
    if (!stats_data || !stats_data.local_node) {
      document.title = "RxOnly";
      return;
    }

    var node_name = get_node_name_from_data(stats_data.local_node);
    var total_nodes = stats_data.stats ? stats_data.stats.total_nodes : 0;

    // Cache the node name for use by update_all_node_counts
    app_state.cached_local_node_name = node_name;

    if (node_name) {
      document.title = node_name + " (" + total_nodes + ")";
    } else {
      document.title = "RxOnly";
    }
  }

  /**
   * Update node count in all display locations:
   * - Page title (if local node name is cached)
   * - Sidebar nodes heading (if no search filter active)
   * - Dashboard stats card (if visible)
   * - Nodes list data attribute
   *
   * Call this whenever a fresh total_nodes count is received from any API.
   */
  function update_all_node_counts(total_nodes) {
    // Update app_state
    app_state.total_nodes = total_nodes;

    // Update page title (only if we have a cached node name)
    if (app_state.cached_local_node_name) {
      document.title = app_state.cached_local_node_name + " (" + total_nodes + ")";
    }

    // Update sidebar nodes heading (only if no search filter)
    if (dom_elements.nodes_count && app_state.nodes_search_query.trim() === "") {
      dom_elements.nodes_count.textContent = "(" + total_nodes + ")";
    }

    // Update nodes list data attribute
    if (dom_elements.nodes_list) {
      dom_elements.nodes_list.dataset.total = total_nodes;
    }

    // Update dashboard stats card (if visible)
    var dashboard_stat = document.getElementById("dashboard-stat-nodes");
    if (dashboard_stat) {
      dashboard_stat.textContent = total_nodes;
    }
  }

  function get_node_url_template() {
    return dom_elements.body.dataset.apiNodeUrlTemplate || "/api/nodes/__NODE_ID__";
  }

  function build_node_url(node_id) {
    return get_node_url_template().replace("__NODE_ID__", encodeURIComponent(node_id));
  }

  function build_message_url(message_id, is_dm) {
    if (is_dm) {
      var dm_template = dom_elements.body.dataset.apiDmUrlTemplate || "/api/direct-messages/__MESSAGE_ID__";
      return dm_template.replace("__MESSAGE_ID__", encodeURIComponent(message_id));
    }
    var msg_template = dom_elements.body.dataset.apiMessageUrlTemplate || "/api/messages/__MESSAGE_ID__";
    return msg_template.replace("__MESSAGE_ID__", encodeURIComponent(message_id));
  }

  function format_timestamp(unix_timestamp) {
    if (!unix_timestamp) {
      return "";
    }
    var date = new Date(unix_timestamp * 1000);
    return date.toLocaleString();
  }

  function format_iso_timestamp(unix_timestamp) {
    if (!unix_timestamp) {
      return "";
    }
    var date = new Date(unix_timestamp * 1000);
    return date.toISOString();
  }

  function escape_html(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function format_node_display_name(node) {
    if (node.long_name && node.short_name) {
      return node.long_name + " (" + node.short_name + ")";
    }
    if (node.long_name) {
      return node.long_name;
    }
    if (node.short_name) {
      return node.short_name;
    }
    return node.node_id;
  }

  /**
   * Format node display name as HTML with spans for styling.
   * Returns HTML string with .node-long-name, .node-short-name, and/or .node-id spans.
   */
  function format_node_display_html(node) {
    var long_name = node.long_name || node.from_node_long_name;
    var short_name = node.short_name || node.from_node_short_name;
    var node_id = node.node_id || node.from_node;

    if (long_name && short_name) {
      return '<span class="node-long-name">' + escape_html(long_name) + '</span> ' +
             '<span class="node-short-name">(' + escape_html(short_name) + ')</span>';
    }
    if (long_name) {
      return '<span class="node-long-name">' + escape_html(long_name) + '</span>';
    }
    if (short_name) {
      return '<span class="node-short-name">' + escape_html(short_name) + '</span>';
    }
    if (node_id) {
      return '<span class="node-id">' + escape_html(node_id) + '</span>';
    }
    return '<span class="node-id">Unknown</span>';
  }


  /* ------------------------------------------
     Template Utilities (populate from JSON)
     ------------------------------------------ */

  /**
   * Access a nested value from an object using dot-notation path.
   * e.g., get_nested_value(data, "local_node.hardware")
   */
  function get_nested_value(obj, path) {
    return path.split(".").reduce(function(o, key) {
      return o != null ? o[key] : undefined;
    }, obj);
  }

  /**
   * Populate a DOM node (fragment or element) with data using a field map.
   *
   * Field map entries support:
   *   - selector: CSS selector to find the target element
   *   - format: optional function(value) -> formatted string
   *   - compute: optional function(data) -> derived value (skips dot-path lookup)
   *
   * When a value is null/empty and the target is inside a <tr>, the row is hidden.
   */
  function populate_fragment(container, data, field_map) {
    var entries = Object.entries(field_map);

    for (var i = 0; i < entries.length; i++) {
      var field = entries[i][0];
      var field_config = entries[i][1];

      var el = container.querySelector(field_config.selector);
      if (!el) continue;

      var value;
      if (field_config.compute) {
        value = field_config.compute(data);
      } else {
        value = get_nested_value(data, field);
      }

      if (value == null || value === "") {
        // Hide parent table row when value is missing
        var hidden_row = el.closest("tr");
        if (hidden_row) {
          hidden_row.setAttribute("hidden", "");
        }
        continue;
      }

      if (field_config.format) {
        value = field_config.format(value);
      }

      // Use innerHTML for HTML content, textContent for plain text
      if (field_config.html) {
        el.innerHTML = String(value);
      } else {
        el.textContent = String(value);
      }

      // Ensure row is visible if it was previously hidden
      var visible_row = el.closest("tr");
      if (visible_row) {
        visible_row.removeAttribute("hidden");
      }
    }
  }

  /**
   * Clone a <template> element and populate it with data using a field map.
   * Returns the populated DocumentFragment, or null if template not found.
   */
  function populate_template(template_id, data, field_map) {
    var template = document.getElementById(template_id);
    if (!template) return null;

    var clone = template.content.cloneNode(true);

    populate_fragment(clone, data, field_map);

    return clone;
  }

  /**
   * Update an already-rendered DOM element in-place using a field map.
   * Used for polling updates (dashboard stats, node detail).
   */
  function update_element(container, data, field_map) {
    if (!container) return;
    populate_fragment(container, data, field_map);
  }


  /* ------------------------------------------
     Field Maps (selector-based data binding)
     ------------------------------------------ */

  var field_maps = {

    dashboard: {
      "local_node.node_id": { selector: "[data-field='node-id']" },
      "local_node.hardware": { selector: "[data-field='hardware']" },
      "local_node.role": { selector: "[data-field='role']" },
      "local_node.first_seen": { selector: "[data-field='first-seen']", format: format_timestamp },
      "local_node.last_seen": { selector: "[data-field='last-seen']", format: format_timestamp },
      "local_node.battery_level": { selector: "[data-field='battery']", format: function(v) { return v + "%"; } },
      "local_node.voltage": { selector: "[data-field='voltage']", format: function(v) { return v + "V"; } },
      "stats.total_nodes": { selector: "#dashboard-stat-nodes" },
      "stats.total_messages": { selector: "#dashboard-stat-messages" },
      "stats.total_direct_messages": { selector: "#dashboard-stat-dms" },
      "stats.total_channels": { selector: "#dashboard-stat-channels" },
    },

    node_detail: {
      "node_id": { selector: "[data-field='node-id']" },
      "short_name": { selector: "[data-field='short-name']" },
      "long_name": { selector: "[data-field='long-name']" },
      "hardware": { selector: "[data-field='hardware']" },
      "role": { selector: "[data-field='role']" },
      "first_seen": { selector: "[data-field='first-seen']", format: format_timestamp },
      "last_seen": { selector: "[data-field='last-seen']", format: format_timestamp },
      "battery_level": { selector: "[data-field='battery']", format: function(v) { return v + "%"; } },
      "voltage": { selector: "[data-field='voltage']", format: function(v) { return v + "V"; } },
      "snr": { selector: "[data-field='snr']" },
      "rssi": { selector: "[data-field='rssi']" },
      "latitude": { selector: "[data-field='latitude']" },
      "longitude": { selector: "[data-field='longitude']" },
      "altitude": { selector: "[data-field='altitude']", format: function(v) { return v + "m"; } },
    },

    message_item: {
      "_from_display": {
        selector: "[data-field='from-node']",
        compute: format_node_display_html,
        html: true,
      },
      "rx_time": { selector: "[data-field='rx-time']", format: format_timestamp },
      "text": { selector: "[data-field='text']" },
    },

    message_detail: {
      "message_id": { selector: "[data-field='message-id']" },
      "_from_display": {
        selector: "[data-field='from-node']",
        compute: format_node_display_html,
        html: true,
      },
      "to_node": { selector: "[data-field='to-node']" },
      "reply_to": { selector: "[data-field='reply-to']" },
      "text": { selector: "[data-field='text']" },
      "rx_time": { selector: "[data-field='rx-time']", format: format_timestamp },
      "_channel_display": {
        selector: "[data-field='channel']",
        compute: function(data) {
          return data.channel_name || (data.channel_index != null ? "Channel " + data.channel_index : null);
        },
      },
      "hop_count": { selector: "[data-field='hop-count']" },
      "snr": { selector: "[data-field='snr']" },
      "rssi": { selector: "[data-field='rssi']" },
      "_via_mqtt": {
        selector: "[data-field='via-mqtt']",
        compute: function(data) { return data.via_mqtt ? "Yes" : "No"; },
      },
    },

  };


  /* ------------------------------------------
     Scroll Preservation Utilities
     ------------------------------------------ */

  /**
   * Get scroll anchor info for a scrollable container.
   * Anchors on the first visible element (top-anchored).
   */
  function get_scroll_anchor(container) {
    if (!container) return null;

    var container_rect = container.getBoundingClientRect();
    var items = container.querySelectorAll("li");

    if (items.length === 0) return null;

    for (var i = 0; i < items.length; i++) {
      var item_rect = items[i].getBoundingClientRect();
      if (item_rect.top >= container_rect.top - 10) {
        return {
          element: items[i],
          offset_from_top: item_rect.top - container_rect.top,
        };
      }
    }

    return null;
  }

  /**
   * Restore scroll position based on anchor info.
   */
  function restore_scroll_anchor(container, anchor) {
    if (!container || !anchor || !anchor.element) return;

    if (!container.contains(anchor.element)) return;

    var container_rect = container.getBoundingClientRect();
    var item_rect = anchor.element.getBoundingClientRect();

    var current_offset = item_rect.top - container_rect.top;
    var adjustment = current_offset - anchor.offset_from_top;
    container.scrollTop += adjustment;
  }

  /**
   * Check if container is scrolled to top (within tolerance).
   */
  function is_at_scroll_top(container) {
    if (!container) return true;
    return container.scrollTop < 10;
  }


  /* ------------------------------------------
     Breadcrumb Reveal on Scroll-Up (Mobile)
     ------------------------------------------ */

  var BREADCRUMB_REVEAL_THRESHOLD = 80; // pixels of upward scroll before reveal

  /**
   * Handle window scroll for breadcrumb reveal behavior.
   * Shows breadcrumb bar when user scrolls up past threshold.
   * Only active on mobile (when body doesn't have breadcrumbs-sticky yet
   * or when we need to manage the sticky state).
   */
  function handle_breadcrumb_scroll() {
    var current_y = window.scrollY;
    var last_y = app_state.breadcrumb_last_scroll_y;
    var delta = current_y - last_y;

    // At top of page: reset everything, remove sticky immediately
    if (current_y <= 0) {
      app_state.breadcrumb_scroll_up_distance = 0;
      app_state.breadcrumb_is_sticky = false;
      dom_elements.body.classList.remove("breadcrumbs-sticky", "breadcrumbs-hiding");
      app_state.breadcrumb_last_scroll_y = current_y;
      return;
    }

    // Scrolling down: reset upward distance, slide breadcrumb up (hide)
    if (delta > 0) {
      app_state.breadcrumb_scroll_up_distance = 0;
      if (app_state.breadcrumb_is_sticky) {
        app_state.breadcrumb_is_sticky = false;
        // Add hiding class to animate slide-up, keep sticky for positioning
        dom_elements.body.classList.add("breadcrumbs-hiding");
      }
    }
    // Scrolling up: accumulate distance
    else if (delta < 0) {
      app_state.breadcrumb_scroll_up_distance += Math.abs(delta);

      // Only reveal after crossing threshold (applies to both first-time and re-reveal)
      if (app_state.breadcrumb_scroll_up_distance >= BREADCRUMB_REVEAL_THRESHOLD) {
        // If hiding, reveal it again
        if (dom_elements.body.classList.contains("breadcrumbs-hiding")) {
          dom_elements.body.classList.remove("breadcrumbs-hiding");
          app_state.breadcrumb_is_sticky = true;
        }
        // First time showing: add sticky with initial off-screen position
        else if (!app_state.breadcrumb_is_sticky) {
          app_state.breadcrumb_is_sticky = true;
          // Start off-screen, then animate in
          dom_elements.body.classList.add("breadcrumbs-sticky", "breadcrumbs-hiding");
          // Force reflow so browser registers the initial state
          void dom_elements.body.offsetHeight;
          // Remove hiding to trigger slide-down animation
          dom_elements.body.classList.remove("breadcrumbs-hiding");
        }
      }
    }

    app_state.breadcrumb_last_scroll_y = current_y;
  }


  /* ------------------------------------------
     localStorage Read Tracking
     ------------------------------------------ */

  /**
   * Build a localStorage key for last-read tracking.
   * @param {boolean} is_dm - true for direct messages
   * @param {number|null} channel_index - channel index (ignored for DMs)
   * @returns {string} localStorage key
   */
  function build_last_read_key(is_dm, channel_index) {
    if (is_dm) return "rxonly_last_read_dm";
    return "rxonly_last_read_ch_" + channel_index;
  }

  /**
   * Get the last-read position for a channel/DM.
   * @returns {{ message_id: number, rx_time: number } | null}
   */
  function get_last_read(is_dm, channel_index) {
    try {
      var key = build_last_read_key(is_dm, channel_index);
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.message_id === "number" && typeof parsed.rx_time === "number") {
        return parsed;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save the last-read position for a channel/DM.
   */
  function set_last_read(is_dm, channel_index, message_id, rx_time) {
    try {
      var key = build_last_read_key(is_dm, channel_index);
      localStorage.setItem(key, JSON.stringify({ message_id: message_id, rx_time: rx_time }));
    } catch (e) {
      // Silently fail if localStorage is unavailable
    }
  }

  /**
   * Scan visible messages and update last-read based on viewport bottom edge.
   * A message is considered "read" when its top edge is inside the visible
   * area of the messages list container (i.e. the user can see it).
   * Also marks qualifying items with the "message-read" class.
   */
  function update_read_position() {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;

    var container_rect = messages_list.getBoundingClientRect();
    var bottom_y = container_rect.bottom;

    var items = messages_list.querySelectorAll("li[data-message-id]");
    var last_read_item = null;

    for (var i = 0; i < items.length; i++) {
      var item_rect = items[i].getBoundingClientRect();
      // Message is "read" if its top is above the bottom of the visible area
      if (item_rect.top < bottom_y) {
        last_read_item = items[i];
        // Mark as read in the DOM
        mark_message_read(items[i]);
      } else {
        break; // Items are in ASC order, no need to check further
      }
    }

    if (last_read_item) {
      var msg_id = parseInt(last_read_item.dataset.messageId, 10);
      var rx_time = parseInt(last_read_item.dataset.rxTime || "0", 10);
      if (msg_id && rx_time) {
        var current = get_last_read(app_state.messages_is_dm, app_state.current_channel_index);
        // Only update if this message is newer than the stored one
        if (!current || rx_time > current.rx_time || (rx_time === current.rx_time && msg_id > current.message_id)) {
          set_last_read(app_state.messages_is_dm, app_state.current_channel_index, msg_id, rx_time);
        }
      }
    }
  }

  /**
   * Mark a single message list item as read.
   */
  function mark_message_read(li) {
    if (!li.classList.contains("message-read")) {
      li.classList.remove("message-unread");
      li.classList.add("message-read");
    }
  }

  /**
   * Mark all messages in the list as read up to (and including) the given
   * message_id / rx_time. Used at render time to stamp already-read items.
   * @param {HTMLElement} messages_ul - The UL element
   * @param {{ message_id: number, rx_time: number }|null} last_read - Stored position
   */
  function mark_read_up_to(messages_ul, last_read) {
    if (!last_read) return;

    var items = messages_ul.querySelectorAll("li[data-message-id]");
    for (var i = 0; i < items.length; i++) {
      var rx = parseInt(items[i].dataset.rxTime || "0", 10);
      var mid = parseInt(items[i].dataset.messageId, 10);
      if (rx < last_read.rx_time || (rx === last_read.rx_time && mid <= last_read.message_id)) {
        mark_message_read(items[i]);
      }
    }
  }

  /**
   * Save the current read position and scroll offset before leaving a messages view.
   * Call this before switching away from a channel/DM view to ensure
   * the read position is persisted even if the user never scrolled.
   */
  function save_read_position_before_leave() {
    if (app_state.current_view !== "channel" && app_state.current_view !== "direct_messages") return;

    update_read_position();

    // Save scroll position for restoration when returning.
    // On desktop the messages list scrolls; on mobile the window scrolls.
    var messages_list = document.getElementById("messages-list");
    if (messages_list) {
      var is_mobile = getComputedStyle(messages_list).overflowY === "visible";
      var scroll_pos = is_mobile ? window.scrollY : messages_list.scrollTop;
      if (scroll_pos > 0) {
        app_state.saved_messages_scroll_top = scroll_pos;
        app_state.saved_messages_is_mobile = is_mobile;
        app_state.saved_messages_channel_index = app_state.current_channel_index;
        app_state.saved_messages_is_dm = app_state.current_view === "direct_messages";
      }
    }
  }

  /**
   * Clear saved scroll position. Call when the saved position is consumed
   * or no longer relevant.
   */
  function clear_saved_scroll_position() {
    app_state.saved_messages_scroll_top = null;
    app_state.saved_messages_is_mobile = false;
    app_state.saved_messages_channel_index = null;
    app_state.saved_messages_is_dm = false;
  }

  /**
   * Check whether a saved scroll position matches the given channel/DM context.
   * @param {boolean} is_dm
   * @param {number|null} channel_index
   * @returns {{ scroll_top: number, is_mobile: boolean }|null} Saved position, or null if no match
   */
  function consume_saved_scroll_position(is_dm, channel_index) {
    if (app_state.saved_messages_scroll_top === null) return null;
    if (app_state.saved_messages_is_dm !== is_dm) {
      clear_saved_scroll_position();
      return null;
    }
    if (!is_dm && app_state.saved_messages_channel_index !== channel_index) {
      clear_saved_scroll_position();
      return null;
    }
    var result = {
      scroll_top: app_state.saved_messages_scroll_top,
      is_mobile: app_state.saved_messages_is_mobile,
    };
    clear_saved_scroll_position();
    return result;
  }


  /* ------------------------------------------
     API Functions
     ------------------------------------------ */

  function get_nodes_list_url() {
    return dom_elements.body.dataset.apiNodesUrl || "/api/nodes";
  }

  function get_stats_url() {
    return dom_elements.body.dataset.apiStatsUrl || "/api/stats";
  }

  function fetch_nodes_page(offset, limit, search) {
    var base_url = get_nodes_list_url();
    var url = base_url + "?offset=" + offset + "&limit=" + limit;
    if (search) {
      url += "&search=" + encodeURIComponent(search);
    }
    return fetch(url).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch nodes: " + response.status);
      }
      return response.json();
    });
  }

  function fetch_stats() {
    var url = get_stats_url();
    return fetch(url).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch stats: " + response.status);
      }
      return response.json();
    });
  }

  /**
   * Unified fetch for messages and direct messages with cursor support.
   * @param {Object} options
   * @param {boolean} options.is_dm - Fetch direct messages instead of channel messages
   * @param {number|null} [options.channel_index] - Channel index (ignored for DMs)
   * @param {number|null} [options.after_rx_time] - Load messages after this timestamp
   * @param {number|null} [options.before_rx_time] - Load messages before this timestamp
   * @param {boolean} [options.newest] - Load the newest page
   * @param {number} [options.limit=50] - Page size
   * @returns {Promise<Object>} API response with meta + messages/direct_messages
   */
  function fetch_message_page(options) {
    var is_dm = options.is_dm || false;
    var base_url = get_nodes_list_url().replace("/nodes", is_dm ? "/direct-messages" : "/messages");
    var params = new URLSearchParams();

    if (!is_dm && options.channel_index != null) {
      params.set("channel_index", String(options.channel_index));
    }
    if (options.after_rx_time != null) {
      params.set("after_rx_time", String(options.after_rx_time));
    }
    if (options.before_rx_time != null) {
      params.set("before_rx_time", String(options.before_rx_time));
    }
    if (options.newest) {
      params.set("newest", "1");
    }
    params.set("limit", String(options.limit || 50));

    var url = base_url + "?" + params.toString();
    return fetch(url).then(function(response) {
      if (!response.ok) {
        throw new Error("Failed to fetch " + (is_dm ? "direct messages" : "messages") + ": " + response.status);
      }
      return response.json();
    });
  }

  /**
   * Update app_state cursor fields from an API response.
   * Call after every successful fetch_message_page.
   */
  function update_message_cursors(data, is_dm) {
    var messages = is_dm ? data.direct_messages : data.messages;
    app_state.messages_has_more_older = data.meta.has_more_older;
    app_state.messages_has_more_newer = data.meta.has_more_newer;
    app_state.messages_total = data.meta.total;

    if (messages.length > 0) {
      var first = messages[0];
      var last = messages[messages.length - 1];
      // Only update oldest cursors if these are actually older
      if (app_state.messages_oldest_rx_time === null || first.rx_time < app_state.messages_oldest_rx_time
          || (first.rx_time === app_state.messages_oldest_rx_time && first.id < app_state.messages_oldest_id)) {
        app_state.messages_oldest_rx_time = first.rx_time;
        app_state.messages_oldest_id = first.id;
      }
      // Only update newest cursors if these are actually newer
      if (app_state.messages_newest_rx_time === null || last.rx_time > app_state.messages_newest_rx_time
          || (last.rx_time === app_state.messages_newest_rx_time && last.id > app_state.messages_newest_id)) {
        app_state.messages_newest_rx_time = last.rx_time;
        app_state.messages_newest_id = last.id;
      }
    }
  }

  /**
   * Reset message pagination state. Call when switching channels/views.
   */
  function reset_message_state() {
    app_state.messages_has_more_older = false;
    app_state.messages_has_more_newer = false;
    app_state.messages_is_loading = false;
    app_state.messages_oldest_rx_time = null;
    app_state.messages_newest_rx_time = null;
    app_state.messages_oldest_id = null;
    app_state.messages_newest_id = null;
    app_state.messages_total = 0;
    // clear_pending_tapbacks is defined in messages.js; safe to call
    // at runtime since all files are loaded before any user interaction.
    RxOnly.clear_pending_tapbacks();
  }


  /* ------------------------------------------
     Breadcrumb Functions
     ------------------------------------------ */

  function render_breadcrumbs() {
    var breadcrumbs_html = app_state.breadcrumbs.map(function(crumb, index) {
      var is_current = index === app_state.breadcrumbs.length - 1;
      if (is_current) {
        return '<li><a href="' + crumb.href + '" aria-current="page" data-view="' + crumb.view + '">' + escape_html(crumb.label) + '</a></li>';
      }
      return '<li><a href="' + crumb.href + '" data-view="' + crumb.view + '">' + escape_html(crumb.label) + '</a></li>';
    }).join("");

    dom_elements.breadcrumbs_list.innerHTML = breadcrumbs_html;
  }

  function set_breadcrumbs(crumbs) {
    app_state.breadcrumbs = crumbs;
    render_breadcrumbs();
  }


  /* ------------------------------------------
     Sidebar Active State
     ------------------------------------------ */

  /**
   * Remove .active class from all sidebar links.
   */
  function clear_sidebar_active() {
    var active_links = document.querySelectorAll(".channel-link.active, .node-link.active");
    for (var i = 0; i < active_links.length; i++) {
      active_links[i].classList.remove("active");
    }
  }


  /* ------------------------------------------
     Namespace Exports
     ------------------------------------------ */

  // Shared data
  RxOnly.config = config;
  RxOnly.app_state = app_state;
  RxOnly.dom_elements = dom_elements;
  RxOnly.field_maps = field_maps;

  // Utilities
  RxOnly.update_page_title = update_page_title;
  RxOnly.update_all_node_counts = update_all_node_counts;
  RxOnly.format_timestamp = format_timestamp;
  RxOnly.format_iso_timestamp = format_iso_timestamp;
  RxOnly.escape_html = escape_html;
  RxOnly.build_node_url = build_node_url;
  RxOnly.build_message_url = build_message_url;
  RxOnly.format_node_display_name = format_node_display_name;
  RxOnly.format_node_display_html = format_node_display_html;

  // Template engine
  RxOnly.get_nested_value = get_nested_value;
  RxOnly.populate_template = populate_template;
  RxOnly.populate_fragment = populate_fragment;
  RxOnly.update_element = update_element;

  // Scroll preservation
  RxOnly.get_scroll_anchor = get_scroll_anchor;
  RxOnly.restore_scroll_anchor = restore_scroll_anchor;
  RxOnly.is_at_scroll_top = is_at_scroll_top;
  RxOnly.handle_breadcrumb_scroll = handle_breadcrumb_scroll;

  // Read tracking
  RxOnly.get_last_read = get_last_read;
  RxOnly.set_last_read = set_last_read;
  RxOnly.update_read_position = update_read_position;
  RxOnly.mark_message_read = mark_message_read;
  RxOnly.mark_read_up_to = mark_read_up_to;
  RxOnly.save_read_position_before_leave = save_read_position_before_leave;
  RxOnly.clear_saved_scroll_position = clear_saved_scroll_position;
  RxOnly.consume_saved_scroll_position = consume_saved_scroll_position;

  // API
  RxOnly.get_nodes_list_url = get_nodes_list_url;
  RxOnly.get_stats_url = get_stats_url;
  RxOnly.fetch_nodes_page = fetch_nodes_page;
  RxOnly.fetch_stats = fetch_stats;
  RxOnly.fetch_message_page = fetch_message_page;
  RxOnly.update_message_cursors = update_message_cursors;
  RxOnly.reset_message_state = reset_message_state;

  // Breadcrumbs
  RxOnly.set_breadcrumbs = set_breadcrumbs;

  // Sidebar active state
  RxOnly.clear_sidebar_active = clear_sidebar_active;

})();
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
/* ============================================
   RxOnly - Nodes Module
   ============================================
   Node search and filtering, node list polling
   updates, infinite scroll for nodes, and
   mobile scroll handling.
   ============================================ */

(function() {
  "use strict";

  var R = window.RxOnly;
  var app_state = R.app_state;
  var dom_elements = R.dom_elements;
  var config = R.config;


  /* ------------------------------------------
     Nodes Search & Filter (server-side)
     ------------------------------------------ */

  /**
   * Handle search input with debounce. Triggers server-side search.
   */
  function handle_nodes_search_input(event) {
    var query = event.target.value.trim();

    if (app_state.nodes_search_debounce_timeout) {
      clearTimeout(app_state.nodes_search_debounce_timeout);
    }

    app_state.nodes_search_debounce_timeout = setTimeout(function() {
      app_state.nodes_search_query = query;

      // Show/hide clear button
      if (dom_elements.nodes_search_clear) {
        if (query === "") {
          dom_elements.nodes_search_clear.setAttribute("hidden", "");
        } else {
          dom_elements.nodes_search_clear.removeAttribute("hidden");
        }
      }

      fetch_and_render_nodes_search();
    }, config.search_debounce_delay);
  }

  /**
   * Fetch nodes from API with optional search filter and render results.
   */
  async function fetch_and_render_nodes_search() {
    var request_id = ++app_state.nodes_search_request_id;
    var query = app_state.nodes_search_query;
    var nodes_list = dom_elements.nodes_list;
    if (!nodes_list) return;

    try {
      var base_url = R.get_nodes_list_url();
      var url;

      if (query) {
        url = base_url + "?search=" + encodeURIComponent(query) + "&limit=1000";
      } else {
        url = base_url + "?offset=0&limit=50";
      }

      var response = await fetch(url);
      if (!response.ok) throw new Error("Search failed: " + response.status);

      // Ignore stale responses
      if (request_id !== app_state.nodes_search_request_id) return;

      var data = await response.json();

      // Rebuild the nodes list
      var fragment = document.createDocumentFragment();

      data.nodes.forEach(function(node) {
        var li = document.createElement("li");
        var node_api_url = R.build_node_url(node.node_id);

        var link = document.createElement("a");
        link.href = node_api_url;
        link.dataset.nodeId = node.node_id;
        link.className = "node-link";

        var name_span = document.createElement("span");
        name_span.className = "node-name";
        name_span.innerHTML = R.format_node_display_html(node);
        link.appendChild(name_span);

        if (node.last_seen) {
          var time_el = document.createElement("time");
          time_el.className = "node-last-seen";
          time_el.setAttribute("datetime", R.format_iso_timestamp(node.last_seen));
          time_el.textContent = R.format_timestamp(node.last_seen);
          link.appendChild(time_el);
        }

        li.appendChild(link);
        fragment.appendChild(li);
      });

      if (data.nodes.length === 0) {
        var empty_li = document.createElement("li");
        empty_li.className = "empty-state";
        empty_li.textContent = query ? "No matching nodes" : "No nodes";
        fragment.appendChild(empty_li);
      }

      // Preserve scroll position on mobile (DOM replacement collapses page height)
      var scroll_y = window.scrollY;

      nodes_list.innerHTML = "";
      nodes_list.appendChild(fragment);

      if (is_mobile_layout()) {
        window.scrollTo(0, scroll_y);
      }

      // Update offset and total for infinite scroll
      nodes_list.dataset.offset = String(data.nodes.length);
      nodes_list.dataset.total = String(data.meta.total);

      // Update counts: when searching, show "X of Y" in heading only;
      // when not searching, update all node count displays
      if (query) {
        dom_elements.nodes_count.textContent = "(" + data.meta.total + " of " + app_state.total_nodes + ")";
      } else {
        R.update_all_node_counts(data.meta.total);
      }

    } catch (error) {
      console.error("Node search failed:", error);
    }
  }

  /**
   * Clear search filter.
   */
  function clear_nodes_search() {
    if (dom_elements.nodes_search_input) {
      dom_elements.nodes_search_input.value = "";
    }
    app_state.nodes_search_query = "";
    if (dom_elements.nodes_search_clear) {
      dom_elements.nodes_search_clear.setAttribute("hidden", "");
    }
    fetch_and_render_nodes_search();
    dom_elements.nodes_search_input.focus();
  }


  /* ------------------------------------------
     Node List Polling Update
     ------------------------------------------ */

  async function update_nodes_list() {
    var nodes_list = dom_elements.nodes_list;
    if (!nodes_list) return;

    var query = app_state.nodes_search_query.trim();
    var was_at_top = R.is_at_scroll_top(nodes_list);
    var anchor = was_at_top ? null : R.get_scroll_anchor(nodes_list);

    try {
      var data;
      if (query) {
        var base_url = R.get_nodes_list_url();
        var response = await fetch(base_url + "?search=" + encodeURIComponent(query) + "&limit=1000");
        if (!response.ok) throw new Error("Failed to fetch nodes");
        data = await response.json();
      } else {
        var current_offset = parseInt(nodes_list.dataset.offset, 10) || 50;
        data = await R.fetch_nodes_page(0, current_offset);
      }

      // Build map of existing nodes by ID
      var existing_items = {};
      nodes_list.querySelectorAll("li").forEach(function(li) {
        var link = li.querySelector(".node-link");
        if (link) {
          existing_items[link.dataset.nodeId] = li;
        }
      });

      // Build new list
      var fragment = document.createDocumentFragment();

      data.nodes.forEach(function(node) {
        if (existing_items[node.node_id]) {
          var li = existing_items[node.node_id];
          var name_span = li.querySelector(".node-name");
          var time_span = li.querySelector(".node-last-seen");

          if (name_span) {
            name_span.innerHTML = R.format_node_display_html(node);
          }
          if (time_span && node.last_seen) {
            time_span.textContent = R.format_timestamp(node.last_seen);
          }

          fragment.appendChild(li);
        } else {
          var new_li = document.createElement("li");
          var node_api_url = R.build_node_url(node.node_id);

          var link = document.createElement("a");
          link.href = node_api_url;
          link.dataset.nodeId = node.node_id;
          link.className = "node-link";

          var new_name_span = document.createElement("span");
          new_name_span.className = "node-name";
          new_name_span.innerHTML = R.format_node_display_html(node);
          link.appendChild(new_name_span);

          if (node.last_seen) {
            var time_el = document.createElement("time");
            time_el.className = "node-last-seen";
            time_el.setAttribute("datetime", R.format_iso_timestamp(node.last_seen));
            time_el.textContent = R.format_timestamp(node.last_seen);
            link.appendChild(time_el);
          }

          new_li.appendChild(link);
          fragment.appendChild(new_li);
        }
      });

      nodes_list.innerHTML = "";
      nodes_list.appendChild(fragment);

      // Update counts: when searching, show "X of Y" in heading only;
      // when not searching, update all node count displays
      if (query) {
        dom_elements.nodes_count.textContent = "(" + data.meta.total + " of " + app_state.total_nodes + ")";
      } else {
        R.update_all_node_counts(data.meta.total);
      }

      // Restore scroll position
      if (was_at_top) {
        nodes_list.scrollTop = 0;
      } else if (anchor) {
        R.restore_scroll_anchor(nodes_list, anchor);
      }

    } catch (error) {
      console.error("Failed to update nodes list:", error);
    }
  }


  /* ------------------------------------------
     Infinite Scroll for Nodes
     ------------------------------------------ */

  async function load_more_nodes() {
    if (app_state.is_loading_more_nodes) {
      return;
    }

    // Skip infinite scroll when search is active
    if (app_state.nodes_search_query.trim() !== "") {
      return;
    }

    var nodes_list = dom_elements.nodes_list;
    var current_offset = parseInt(nodes_list.dataset.offset, 10) || 0;
    var total_nodes = parseInt(nodes_list.dataset.total, 10) || 0;

    if (current_offset >= total_nodes) {
      return;
    }

    app_state.is_loading_more_nodes = true;

    try {
      var data = await R.fetch_nodes_page(current_offset, 50);

      var fragment = document.createDocumentFragment();

      data.nodes.forEach(function(node) {
        var li = document.createElement("li");
        var node_api_url = R.build_node_url(node.node_id);

        var link = document.createElement("a");
        link.href = node_api_url;
        link.dataset.nodeId = node.node_id;
        link.className = "node-link";

        var name_span = document.createElement("span");
        name_span.className = "node-name";
        name_span.innerHTML = R.format_node_display_html(node);
        link.appendChild(name_span);

        if (node.last_seen) {
          var time_el = document.createElement("time");
          time_el.className = "node-last-seen";
          time_el.setAttribute("datetime", R.format_iso_timestamp(node.last_seen));
          time_el.textContent = R.format_timestamp(node.last_seen);
          link.appendChild(time_el);
        }

        li.appendChild(link);
        fragment.appendChild(li);
      });

      nodes_list.appendChild(fragment);
      nodes_list.dataset.offset = current_offset + data.nodes.length;

    } catch (error) {
      console.error("Failed to load more nodes:", error);
    } finally {
      app_state.is_loading_more_nodes = false;
    }
  }


  /* ------------------------------------------
     Node Scroll Handling
     ------------------------------------------ */

  function handle_nodes_scroll() {
    var nodes_list = dom_elements.nodes_list;

    // Pause updates while scrolling
    app_state.nodes_scroll_paused = true;

    if (app_state.nodes_scroll_timeout) {
      clearTimeout(app_state.nodes_scroll_timeout);
    }

    app_state.nodes_scroll_timeout = setTimeout(function() {
      app_state.nodes_scroll_paused = false;
    }, config.scroll_debounce_delay);

    // Skip infinite scroll when search is active
    if (app_state.nodes_search_query.trim() !== "") {
      return;
    }

    // Infinite scroll check
    var scroll_position = nodes_list.scrollTop + nodes_list.clientHeight;
    var scroll_threshold = nodes_list.scrollHeight - 100;

    if (scroll_position >= scroll_threshold) {
      load_more_nodes();
    }
  }

  /**
   * Mobile infinite scroll handler.
   * On mobile, nodes-list has overflow-y: visible so scroll events
   * on the list don't fire. Detect window scroll near page bottom instead.
   */
  function is_mobile_layout() {
    if (!dom_elements.nodes_list) return false;
    return getComputedStyle(dom_elements.nodes_list).overflowY === "visible";
  }

  function handle_window_scroll() {
    if (!is_mobile_layout()) return;

    if (app_state.nodes_search_query.trim() !== "") return;

    if (dom_elements.app_layout.classList.contains("viewing-detail")) return;

    // Pause updates during scroll
    app_state.nodes_scroll_paused = true;
    if (app_state.nodes_scroll_timeout) {
      clearTimeout(app_state.nodes_scroll_timeout);
    }
    app_state.nodes_scroll_timeout = setTimeout(function() {
      app_state.nodes_scroll_paused = false;
    }, config.scroll_debounce_delay);

    // Check if near bottom of page
    var scroll_position = window.scrollY + window.innerHeight;
    var page_height = document.documentElement.scrollHeight;

    if (page_height - scroll_position < 200) {
      load_more_nodes();
    }
  }


  /* ------------------------------------------
     Namespace Exports
     ------------------------------------------ */

  R.handle_nodes_search_input = handle_nodes_search_input;
  R.fetch_and_render_nodes_search = fetch_and_render_nodes_search;
  R.clear_nodes_search = clear_nodes_search;
  R.update_nodes_list = update_nodes_list;
  R.handle_nodes_scroll = handle_nodes_scroll;
  R.handle_window_scroll = handle_window_scroll;
  R.is_mobile_layout = is_mobile_layout;

})();
/* ============================================
   RxOnly - Views, Polling & Initialization
   ============================================
   Home/dashboard view, node detail view,
   polling and background updates, connection
   error display, event handlers, and app
   initialization.
   ============================================ */

(function() {
  "use strict";

  var R = window.RxOnly;
  var app_state = R.app_state;
  var dom_elements = R.dom_elements;
  var config = R.config;
  var field_maps = R.field_maps;


  /* ------------------------------------------
     View Display Functions
     ------------------------------------------ */

  async function show_home_view() {
    R.save_read_position_before_leave();
    R.clear_saved_scroll_position();
    app_state.current_view = "home";
    app_state.current_channel_index = null;
    app_state.current_channel_name = null;
    app_state.current_channel_url = null;
    app_state.current_node_url = null;
    dom_elements.app_layout.classList.remove("viewing-detail");
    R.clear_sidebar_active();

    R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);

    // Check if dashboard is already server-side rendered (first page load)
    var existing_dashboard = dom_elements.main_content.querySelector("#dashboard");
    if (existing_dashboard) {
      return;
    }

    // Navigating back to dashboard - clone template and populate
    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      var data = await R.fetch_stats();

      var content = R.populate_template("template-dashboard", data, field_maps.dashboard);
      if (content) {
        // Set the heading (requires conditional logic beyond simple field mapping)
        var heading = content.querySelector(".dashboard-node-name");
        var subheading = content.querySelector(".dashboard-node-short");
        var local_node = data.local_node || {};

        if (heading) {
          if (local_node.long_name) {
            heading.textContent = local_node.long_name;
          } else if (local_node.short_name) {
            heading.textContent = local_node.short_name;
          } else if (local_node.node_id) {
            heading.textContent = local_node.node_id;
          } else {
            heading.textContent = "Unknown Node";
          }
        }

        if (subheading) {
          if (local_node.long_name && local_node.short_name) {
            subheading.textContent = local_node.short_name;
          } else {
            subheading.textContent = "";
          }
        }

        dom_elements.main_content.innerHTML = "";
        dom_elements.main_content.appendChild(content);
      }

      R.update_page_title(data);
      check_for_state_change(data);
    } catch (error) {
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading dashboard: ' + R.escape_html(error.message) + '</p>';
      R.update_page_title(null);
    }
  }

  async function show_node_detail(node_api_url, from_content) {
    R.save_read_position_before_leave();

    // Save previous view context for breadcrumb navigation
    app_state.previous_view = app_state.current_view;
    app_state.previous_channel_index = app_state.current_channel_index;
    app_state.previous_channel_name = app_state.current_channel_name;
    app_state.previous_channel_url = app_state.current_channel_url;

    app_state.current_view = "node";
    app_state.current_node_url = node_api_url;
    dom_elements.app_layout.classList.add("viewing-detail");

    R.clear_sidebar_active();
    if (dom_elements.nodes_list) {
      var sidebar_node = dom_elements.nodes_list.querySelector('.node-link[href="' + node_api_url + '"]');
      if (sidebar_node) sidebar_node.classList.add("active");
    }

    dom_elements.main_content.innerHTML = "<p>Loading...</p>";

    try {
      var response = await fetch(node_api_url);
      var data = await response.json();

      if (!response.ok) {
        var error_msg = data.error || "Node not found";
        R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);
        dom_elements.main_content.innerHTML = '<p class="error-state">' + R.escape_html(error_msg) + '</p>';
        return;
      }

      var node_name = data.long_name || data.short_name || data.node_id;

      // Build breadcrumbs with channel context only when navigated from message content
      var crumbs = [{ label: "Dashboard", href: "/", view: "home" }];

      if (from_content && app_state.previous_view === "channel" && app_state.previous_channel_name) {
        crumbs.push({
          label: app_state.previous_channel_name,
          href: app_state.previous_channel_url,
          view: "channel",
        });
      } else if (from_content && app_state.previous_view === "direct_messages") {
        crumbs.push({
          label: "Direct Messages",
          href: app_state.previous_channel_url,
          view: "direct_messages",
        });
      }

      crumbs.push({ label: node_name, href: node_api_url, view: "node" });
      R.set_breadcrumbs(crumbs);

      var content = R.populate_template("template-node-detail", data, field_maps.node_detail);
      if (content) {
        var detail_heading = content.querySelector("[data-field='heading']");
        if (detail_heading) {
          detail_heading.textContent = R.format_node_display_name(data);
        }

        // Show map link if both latitude and longitude are present
        if (data.latitude != null && data.longitude != null) {
          var map_link_container = content.querySelector(".node-map-link");
          var map_link = content.querySelector("[data-field='map-link']");
          if (map_link_container && map_link) {
            map_link.href = "https://www.openstreetmap.org/?mlat=" + data.latitude + "&mlon=" + data.longitude + "#map=9";
            map_link_container.removeAttribute("hidden");
          }
        }

        dom_elements.main_content.innerHTML = "";
        dom_elements.main_content.appendChild(content);
      }
    } catch (error) {
      R.set_breadcrumbs([{ label: "Dashboard", href: "/", view: "home" }]);
      dom_elements.main_content.innerHTML = '<p class="error-state">Error loading node</p>';
    }
  }


  /* ------------------------------------------
     Polling & Updates
     ------------------------------------------ */

  function check_for_state_change(stats_data) {
    if (!stats_data || !stats_data.local_node) return;

    var local_node = stats_data.local_node;

    // Initialize known state on first run
    if (app_state.known_local_node_id === null) {
      app_state.known_local_node_id = local_node.node_id;
      app_state.known_first_seen = local_node.first_seen;
      return;
    }

    // Check for device swap (node_id changed)
    if (local_node.node_id !== app_state.known_local_node_id) {
      console.log("Device changed, refreshing page...");
      window.location.reload();
      return;
    }

    // Check for database reset (first_seen changed)
    if (local_node.first_seen !== app_state.known_first_seen) {
      console.log("Database reset detected, refreshing page...");
      window.location.reload();
      return;
    }
  }

  function update_sidebar_counts(stats_data) {
    if (!stats_data || !stats_data.stats) return;

    // Use centralized function to update all node count displays
    R.update_all_node_counts(stats_data.stats.total_nodes);
  }

  function update_channel_counts(stats_data) {
    if (!stats_data || !stats_data.stats) return;

    var stats = stats_data.stats;
    var channel_counts = stats.channel_counts || {};

    if (dom_elements.channels_list) {
      dom_elements.channels_list.querySelectorAll(".channel-link").forEach(function(link) {
        var channel_index = link.dataset.channelIndex;
        var count_span = link.querySelector(".channel-count");

        if (!count_span) return;

        if (channel_index === "dm") {
          count_span.textContent = "(" + stats.total_direct_messages + ")";
        } else {
          var count = channel_counts[parseInt(channel_index, 10)] || 0;
          count_span.textContent = "(" + count + ")";
        }
      });
    }
  }

  function update_dashboard_stats(stats_data) {
    if (app_state.current_view !== "home") return;
    if (!stats_data || !stats_data.stats) return;

    var dashboard = document.getElementById("dashboard");
    if (!dashboard) return;

    R.update_element(dashboard, stats_data, field_maps.dashboard);

    // Update heading (conditional logic)
    var local_node = stats_data.local_node || {};
    var heading = dashboard.querySelector(".dashboard-node-name");
    var subheading = dashboard.querySelector(".dashboard-node-short");

    if (heading) {
      if (local_node.long_name) {
        heading.textContent = local_node.long_name;
      } else if (local_node.short_name) {
        heading.textContent = local_node.short_name;
      } else if (local_node.node_id) {
        heading.textContent = local_node.node_id;
      }
    }

    if (subheading) {
      if (local_node.long_name && local_node.short_name) {
        subheading.textContent = local_node.short_name;
      } else {
        subheading.textContent = "";
      }
    }
  }

  async function run_fast_poll() {
    try {
      var stats_data = await R.fetch_stats();

      app_state.poll_failure_count = 0;
      hide_connection_error();

      check_for_state_change(stats_data);
      R.update_page_title(stats_data);
      update_sidebar_counts(stats_data);
      update_channel_counts(stats_data);
      update_dashboard_stats(stats_data);

    } catch (error) {
      app_state.poll_failure_count++;
      console.error("Fast poll failed:", error);

      if (app_state.poll_failure_count >= config.max_poll_failures) {
        show_connection_error();
      }
    }
  }

  async function run_slow_poll() {
    // Update nodes list (skip if scroll is paused)
    if (!app_state.nodes_scroll_paused) {
      try {
        await R.update_nodes_list();
      } catch (error) {
        console.error("Slow poll (nodes) failed:", error);
      }
    }

    // Update messages if viewing a channel
    if (!app_state.messages_scroll_paused) {
      if (app_state.current_view === "channel" && app_state.current_channel_index !== null) {
        try {
          await update_messages_list(false);
        } catch (error) {
          console.error("Slow poll (messages) failed:", error);
        }
      } else if (app_state.current_view === "direct_messages") {
        try {
          await update_messages_list(true);
        } catch (error) {
          console.error("Slow poll (DMs) failed:", error);
        }
      }
    }

    // Update node detail if viewing
    if (app_state.current_view === "node" && app_state.current_node_url) {
      try {
        var response = await fetch(app_state.current_node_url);
        if (response.ok) {
          var node = await response.json();
          var node_detail = document.querySelector(".node-detail");
          if (node_detail) {
            R.update_element(node_detail, node, field_maps.node_detail);

            var detail_heading = node_detail.querySelector("[data-field='heading']");
            if (detail_heading) {
              detail_heading.textContent = R.format_node_display_name(node);
            }

            // Update map link if both latitude and longitude are present
            if (node.latitude != null && node.longitude != null) {
              var map_link_container = node_detail.querySelector(".node-map-link");
              var map_link = node_detail.querySelector("[data-field='map-link']");
              if (map_link_container && map_link) {
                map_link.href = "https://www.openstreetmap.org/?mlat=" + node.latitude + "&mlon=" + node.longitude + "#map=9";
                map_link_container.removeAttribute("hidden");
              }
            }
          }
        }
      } catch (error) {
        console.error("Slow poll (node detail) failed:", error);
      }
    }
  }

  /**
   * Poll for new messages and silently append them to the bottom.
   * Only fetches messages newer than what we already have loaded.
   * Updates the "Jump to newest" button state.
   */
  async function update_messages_list(is_direct_messages) {
    var messages_list = document.getElementById("messages-list");
    if (!messages_list) return;
    if (app_state.messages_is_loading) return;

    // If we have no cursor yet (empty view), skip poll update
    if (app_state.messages_newest_rx_time === null) return;

    try {
      var data = await R.fetch_message_page({
        is_dm: is_direct_messages,
        channel_index: is_direct_messages ? null : app_state.current_channel_index,
        after_rx_time: app_state.messages_newest_rx_time,
      });

      var messages = is_direct_messages ? data.direct_messages : data.messages;

      if (messages.length > 0) {
        // Update newest cursors
        var last = messages[messages.length - 1];
        app_state.messages_newest_rx_time = last.rx_time;
        app_state.messages_newest_id = last.id;

        // Silently append new messages to the bottom
        R.append_messages_to_list(messages_list, messages, is_direct_messages);
      }

      // Update has_more_newer from the server response
      app_state.messages_has_more_newer = data.meta.has_more_newer;
      app_state.messages_total = data.meta.total;
      R.update_jump_to_newest_button();

    } catch (error) {
      console.error("Failed to update messages list:", error);
    }
  }

  function start_polling() {
    stop_polling();

    app_state.fast_poll_timer = setInterval(run_fast_poll, config.fast_poll_interval);
    app_state.slow_poll_timer = setInterval(run_slow_poll, config.slow_poll_interval);
  }

  function stop_polling() {
    if (app_state.fast_poll_timer) {
      clearInterval(app_state.fast_poll_timer);
      app_state.fast_poll_timer = null;
    }
    if (app_state.slow_poll_timer) {
      clearInterval(app_state.slow_poll_timer);
      app_state.slow_poll_timer = null;
    }
  }


  /* ------------------------------------------
     Connection Error Display
     ------------------------------------------ */

  function show_connection_error() {
    if (document.getElementById("connection-error")) return;

    var error_div = document.createElement("div");
    error_div.id = "connection-error";
    error_div.className = "connection-error";
    error_div.textContent = "Connection issue - retrying...";

    document.body.insertBefore(error_div, document.body.firstChild);
  }

  function hide_connection_error() {
    var error_div = document.getElementById("connection-error");
    if (error_div) {
      error_div.remove();
    }
  }


  /* ------------------------------------------
     Hash Routing
     ------------------------------------------ */

  /**
   * Parse the current hash and route to the appropriate view.
   * Returns false for invalid routes (caller should redirect to dashboard).
   *
   * Supported patterns:
   *   ""  or "#"           → Dashboard
   *   "#node/!3265cf81"    → Node detail
   *   "#channel/1"         → Channel messages
   *   "#dm"                → Direct messages list
   *   "#message/2217203483"→ Channel message detail
   *   "#dm/2217203483"     → DM detail
   */
  async function route_from_hash(hash) {
    // Strip leading "#"
    var path = hash.replace(/^#/, "");

    // Empty hash → dashboard
    if (!path) {
      show_home_view();
      return true;
    }

    var parts = path.split("/");
    var route = parts[0];
    var param = parts.slice(1).join("/");  // rejoin in case param contains "/"

    if (route === "node" && param) {
      var node_url = R.build_node_url(param);
      var from_content = app_state.navigating_from_content;
      app_state.navigating_from_content = false;
      show_node_detail(node_url, from_content);
      return true;
    }

    if (route === "channel" && param) {
      var channel_index = parseInt(param, 10);
      if (isNaN(channel_index)) return false;

      // Look up channel name and API URL from sidebar
      var channel_link = dom_elements.channels_list
        ? dom_elements.channels_list.querySelector(
            '.channel-link[data-channel-index="' + channel_index + '"]'
          )
        : null;
      if (!channel_link) return false;

      var channel_name_el = channel_link.querySelector(".channel-name");
      var channel_name = channel_name_el
        ? channel_name_el.textContent.trim()
        : "Channel " + channel_index;
      var channel_api_url = channel_link.getAttribute("href");

      var result = await R.show_channel_messages(channel_api_url, channel_name, channel_index);
      return result !== false;
    }

    if (route === "dm" && !param) {
      // DM list
      var dm_link = dom_elements.channels_list
        ? dom_elements.channels_list.querySelector('.channel-link[data-channel-index="dm"]')
        : null;
      if (!dm_link) return false;

      var dm_api_url = dm_link.getAttribute("href");
      R.show_direct_messages(dm_api_url);
      return true;
    }

    if (route === "dm" && param) {
      // DM detail
      R.show_message_detail(param, true);
      return true;
    }

    if (route === "message" && param) {
      R.show_message_detail(param, false);
      return true;
    }

    return false;
  }

  function handle_hash_change() {
    var success = route_from_hash(location.hash);

    // route_from_hash is async, handle the promise
    if (success && typeof success.then === "function") {
      success.then(function(ok) {
        if (!ok) {
          // Invalid route — clear hash and go to dashboard
          history.replaceState(null, "", location.pathname);
          show_home_view();
        }
      });
    } else if (!success) {
      history.replaceState(null, "", location.pathname);
      show_home_view();
    }
  }


  /* ------------------------------------------
     Event Handlers
     ------------------------------------------ */

  function handle_channel_click(event) {
    var channel_link = event.target.closest(".channel-link");
    if (!channel_link) {
      return;
    }

    event.preventDefault();

    var channel_index = channel_link.dataset.channelIndex;

    if (channel_index === "dm") {
      location.hash = "dm";
    } else {
      location.hash = "channel/" + channel_index;
    }
  }

  function handle_node_click(event) {
    var node_link = event.target.closest(".node-link");
    if (!node_link) {
      return;
    }

    event.preventDefault();

    var node_id = node_link.dataset.nodeId;
    location.hash = "node/" + node_id;
  }
  
  function handle_nodes_heading_click(event) {
    if (!R.is_mobile_layout() && dom_elements.nodes_list) {
      dom_elements.nodes_list.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function handle_breadcrumb_click(event) {
    var breadcrumb_link = event.target.closest("a");
    if (!breadcrumb_link) {
      return;
    }

    var view = breadcrumb_link.dataset.view;
    event.preventDefault();

    if (view === "home") {
      // If already on dashboard and breadcrumbs are sticky, scroll to top
      if (app_state.current_view === "home" && app_state.breadcrumb_is_sticky) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      if (location.hash) {
        location.hash = "";
      } else {
        show_home_view();
      }
    } else if (view === "channel") {
      var ch_index = app_state.current_channel_index != null
        ? app_state.current_channel_index
        : app_state.previous_channel_index;
      if (ch_index != null) {
        location.hash = "channel/" + ch_index;
      }
    } else if (view === "direct_messages") {
      location.hash = "dm";
    }
  }

  /**
   * Delegated click handler for main content area.
   * Handles: node links in messages, message timestamp links.
   */
  function handle_main_content_click(event) {
    // Reply bar click — navigate to parent message detail
    var reply_bar = event.target.closest(".message-reply-bar[data-reply-to-id]");
    if (reply_bar) {
      event.preventDefault();
      var reply_to_id = reply_bar.dataset.replyToId;
      var is_dm_reply = app_state.current_view === "direct_messages";
      location.hash = (is_dm_reply ? "dm/" : "message/") + reply_to_id;
      return;
    }

    // Message detail reply-to link — navigate to parent message
    var reply_to_link = event.target.closest(".message-detail-reply-to[data-reply-to-id]");
    if (reply_to_link) {
      event.preventDefault();
      var parent_id = reply_to_link.dataset.replyToId;
      var is_dm_context = app_state.current_view === "message" && app_state.previous_view === "direct_messages";
      location.hash = (is_dm_context ? "dm/" : "message/") + parent_id;
      return;
    }

    // Tapback pill click (check first — pills are inside message items)
    var tapback_pill = event.target.closest(".tapback-pill[data-tapback-id]");
    if (tapback_pill) {
      event.preventDefault();
      var tapback_id = tapback_pill.dataset.tapbackId;
      var is_dm = app_state.current_view === "direct_messages";
      location.hash = (is_dm ? "dm/" : "message/") + tapback_id;
      return;
    }

    // Message timestamp link (check before node-link to avoid catching it)
    var time_link = event.target.closest(".message-time-link");
    if (time_link) {
      event.preventDefault();
      var li = time_link.closest("li[data-message-id]");
      if (li) {
        var message_id = li.dataset.messageId;
        var is_dm_msg = app_state.current_view === "direct_messages";
        location.hash = (is_dm_msg ? "dm/" : "message/") + message_id;
      }
      return;
    }

    // Node link in messages
    var node_link = event.target.closest(".node-link");
    if (node_link) {
      event.preventDefault();
      app_state.navigating_from_content = true;
      var node_id = node_link.dataset.nodeId;
      location.hash = "node/" + node_id;
      return;
    }
  }


  /* ------------------------------------------
     Initialization
     ------------------------------------------ */

  function initialize_event_listeners() {
    // Channel clicks
    if (dom_elements.channels_list) {
      dom_elements.channels_list.addEventListener("click", handle_channel_click);
    }
    
    // Nodes list heading (sidebar)
    if (dom_elements.nodes_list_heading) {
      dom_elements.nodes_list_heading.addEventListener("click", handle_nodes_heading_click);
    }

    // Node clicks (sidebar)
    if (dom_elements.nodes_list) {
      dom_elements.nodes_list.addEventListener("click", handle_node_click);
      dom_elements.nodes_list.addEventListener("scroll", R.handle_nodes_scroll);
    }

    // Device bar home link
    var device_bar_home = document.querySelector(".device-bar-home");
    if (device_bar_home) {
      device_bar_home.addEventListener("click", function(event) {
        event.preventDefault();
        if (location.hash) {
          location.hash = "";
        } else {
          show_home_view();
        }
      });
    }

    // Hash routing
    window.addEventListener("hashchange", handle_hash_change);

    // Main content clicks (node links in messages, message timestamps)
    if (dom_elements.main_content) {
      dom_elements.main_content.addEventListener("click", handle_main_content_click);
    }

    // Nodes search
    if (dom_elements.nodes_search_input) {
      dom_elements.nodes_search_input.addEventListener("input", R.handle_nodes_search_input);

      dom_elements.nodes_search_input.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
          event.preventDefault();

          if (app_state.nodes_search_debounce_timeout) {
            clearTimeout(app_state.nodes_search_debounce_timeout);
          }

          app_state.nodes_search_query = dom_elements.nodes_search_input.value.trim();

          if (dom_elements.nodes_search_clear) {
            if (app_state.nodes_search_query === "") {
              dom_elements.nodes_search_clear.setAttribute("hidden", "");
            } else {
              dom_elements.nodes_search_clear.removeAttribute("hidden");
            }
          }

          R.fetch_and_render_nodes_search();
        }
      });
    }

    // Nodes search clear button
    if (dom_elements.nodes_search_clear) {
      dom_elements.nodes_search_clear.addEventListener("click", R.clear_nodes_search);
    }

    // Breadcrumb clicks
    if (dom_elements.breadcrumbs_list) {
      dom_elements.breadcrumbs_list.addEventListener("click", handle_breadcrumb_click);
    }

    // Messages scroll (delegated)
    R.setup_messages_scroll_listener();

    // Mobile infinite scroll (nodes + messages) + breadcrumb reveal
    window.addEventListener("scroll", function() {
      R.handle_window_scroll();
      R.handle_messages_window_scroll();
      R.handle_breadcrumb_scroll();
    }, { passive: true });
  }

  function initialize_app() {
    document.body.classList.remove("no-js");

    initialize_event_listeners();

    // Route based on initial hash, or show dashboard
    if (location.hash && location.hash !== "#") {
      route_from_hash(location.hash).then(function(ok) {
        if (!ok) {
          history.replaceState(null, "", location.pathname);
          show_home_view();
        }
      });
    } else {
      // Dashboard is server-side rendered on first load.
      // show_home_view detects #dashboard and skips the fetch.
      show_home_view();
    }

    start_polling();
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize_app);
  } else {
    initialize_app();
  }

})();
