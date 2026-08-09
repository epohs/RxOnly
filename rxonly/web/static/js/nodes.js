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
