/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
(function(scope) {

  /********************* base setup *********************/
  const IMPORT_SELECTOR = 'link[rel=import]';
  const useNative = Boolean('import' in document.createElement('link'));

  // Polyfill `currentScript` for browsers without it.
  let currentScript = null;
  if ('currentScript' in document === false) {
    Object.defineProperty(document, 'currentScript', {
      get: function() {
        return currentScript ||
          // NOTE: only works when called in synchronously executing code.
          // readyState should check if `loading` but IE10 is
          // interactive when scripts run so we cheat. This is not needed by
          // html-imports polyfill but helps generally polyfill `currentScript`.
          (document.readyState !== 'complete' ?
            document.scripts[document.scripts.length - 1] : null);
      },
      configurable: true
    });
  }

  /********************* path fixup *********************/
  const ABS_URL_TEST = /(^\/)|(^#)|(^[\w-\d]*:)/;
  const CSS_URL_REGEXP = /(url\()([^)]*)(\))/g;
  const CSS_IMPORT_REGEXP = /(@import[\s]+(?!url\())([^;]*)(;)/g;


  // path fixup: style elements in imports must be made relative to the main
  // document. We fixup url's in url() and @import.
  const Path = {

    fixUrls: function(element, base) {
      if (element.href) {
        element.setAttribute('href',
          Path.replaceAttrUrl(element.getAttribute('href'), base));
      }
      if (element.src) {
        element.setAttribute('src',
          Path.replaceAttrUrl(element.getAttribute('src'), base));
      }
      if (element.localName === 'style') {
        Path.resolveUrlsInStyle(element, base);
      } else if (element.localName === 'script' && element.textContent) {
        element.textContent += `\n//# sourceURL=${base}`;
      }
    },

    fixUrlAttributes: function(element, base) {
      const attrs = ['action', 'src', 'href', 'url', 'style'];
      for (let i = 0, a; i < attrs.length && (a = attrs[i]); i++) {
        const at = element.attributes[a];
        const v = at && at.value;
        if (v && (v.search(/({{|\[\[)/) < 0)) {
          at.value = (a === 'style') ?
            Path.resolveUrlsInCssText(v, base) :
            Path.replaceAttrUrl(v, base);
        }
      }
    },

    fixUrlsInTemplates: function(element, base) {
      const t$ = element.querySelectorAll('template');
      for (let i = 0; i < t$.length; i++) {
        Path.fixUrlsInTemplate(t$[i], base);
      }
    },

    fixUrlsInTemplate: function(template, base) {
      const content = template.content;
      if (!content) { // Template not supported.
        return;
      }
      const n$ = content.querySelectorAll(
        'style, form[action], [src], [href], [url], [style]');
      for (let i = 0; i < n$.length; i++) {
        const n = n$[i];
        if (n.localName == 'style') {
          Path.resolveUrlsInStyle(n, base);
        } else {
          Path.fixUrlAttributes(n, base);
        }
      }
      Path.fixUrlsInTemplates(content, base);
    },

    resolveUrlsInStyle: function(style, linkUrl) {
      style.textContent = Path.resolveUrlsInCssText(style.textContent, linkUrl);
    },

    resolveUrlsInCssText: function(cssText, linkUrl) {
      let r = Path.replaceUrls(cssText, linkUrl, CSS_URL_REGEXP);
      r = Path.replaceUrls(r, linkUrl, CSS_IMPORT_REGEXP);
      return r;
    },

    replaceUrls: function(text, linkUrl, regexp) {
      return text.replace(regexp, function(m, pre, url, post) {
        let urlPath = url.replace(/["']/g, '');
        if (linkUrl) {
          urlPath = Path._resolveUrl(urlPath, linkUrl);
        }
        return pre + '\'' + urlPath + '\'' + post;
      });
    },

    replaceAttrUrl: function(text, linkUrl) {
      if (text && ABS_URL_TEST.test(text)) {
        return text;
      } else {
        return Path._resolveUrl(text, linkUrl);
      }
    },

    _resolveUrl: function(url, base) {
      // Lazy feature detection.
      if (Path.__workingURL === undefined) {
        Path.__workingURL = false;
        try {
          const u = new URL('b', 'http://a');
          u.pathname = 'c%20d';
          Path.__workingURL = (u.href === 'http://a/c%20d');
        } catch (e) {}
      }

      if (Path.__workingURL) {
        return (new URL(url, base)).href;
      }

      // Fallback to creating an anchor into a disconnected document.
      let doc = Path.__tempDoc;
      if (!doc) {
        doc = document.implementation.createHTMLDocument('temp');
        Path.__tempDoc = doc;
        doc.__base = doc.createElement('base');
        doc.head.appendChild(doc.__base);
        doc.__anchor = doc.createElement('a');
      }
      doc.__base.href = base;
      doc.__anchor.href = url;
      return doc.__anchor.href || url;
    }
  };

  /********************* Xhr processor *********************/
  const Xhr = {

    async: true,

    /**
     * @param {!string} url
     * @param {!function(boolean, ?, string=)} callback
     * @return {XMLHttpRequest}
     */
    load: function(url, callback) {
      const request = new XMLHttpRequest();
      request.open('GET', url, Xhr.async);
      request.addEventListener('readystatechange', (e) => {
        if (request.readyState === 4) {
          // Servers redirecting an import can add a Location header to help us
          // polyfill correctly.
          let redirectedUrl = undefined;
          try {
            const locationHeader = request.getResponseHeader('Location');
            if (locationHeader) {
              // Relative or full path.
              redirectedUrl = (locationHeader.substr(0, 1) === '/') ?
                location.origin + locationHeader : locationHeader;
            }
          } catch (e) {
            console.error(e.message);
          }
          const isOk = ((request.status >= 200 && request.status < 300) ||
            request.status === 304 || request.status === 0);
          const resource = (request.response || request.responseText);
          callback(!isOk, resource, redirectedUrl);
        }
      });
      request.send();
      return request;
    }
  };

  /********************* loader *********************/
  // This loader supports a dynamic list of urls
  // and an oncomplete callback that is called when the loader is done.
  // NOTE: The polyfill currently does *not* need this dynamism or the
  // onComplete concept. Because of this, the loader could be simplified
  // quite a bit.
  class Loader {
    constructor(onLoad, onComplete) {
      this.cache = {};
      this.onload = onLoad;
      this.oncomplete = onComplete;
      this.inflight = 0;
      this.pending = {};
    }

    /**
     * @param {!Element} node
     */
    addNode(node) {
      // number of transactions to complete
      this.inflight++;
      // commence transactions
      this.require(node);
      // anything to do?
      this.checkDone();
    }

    /**
     * @param {!Element} elt
     */
    require(elt) {
      const url = elt.href || elt.src;
      // deduplication
      if (!this.dedupe(url, elt)) {
        // fetch this resource
        this.fetch(url, elt);
      }
    }

    /**
     * @param {string} url
     * @param {!Element} elt
     * @return {boolean}
     */
    dedupe(url, elt) {
      if (this.pending[url]) {
        // add to list of nodes waiting for inUrl
        this.pending[url].push(elt);
        // don't need fetch
        return true;
      }
      let resource;
      if (this.cache[url]) {
        this.onload(url, elt, this.cache[url]);
        // finished this transaction
        this.tail();
        // don't need fetch
        return true;
      }
      // first node waiting for inUrl
      this.pending[url] = [elt];
      // need fetch (not a dupe)
      return false;
    }

    /**
     * @param {string} url
     * @param {!Element} elt
     */
    fetch(url, elt) {
      if (!url) {
        this.receive(url, elt, true, 'error: href must be specified');
      } else if (url.match(/^data:/)) {
        // Handle Data URI Scheme
        const pieces = url.split(',');
        const header = pieces[0];
        let body = pieces[1];
        if (header.indexOf(';base64') > -1) {
          body = atob(body);
        } else {
          body = decodeURIComponent(body);
        }
        this.receive(url, elt, false, body);
      } else {
        Xhr.load(url, (error, resource, redirectedUrl) =>
          this.receive(url, elt, error, resource, redirectedUrl));
      }
    }

    /**
     * @param {!string} url
     * @param {!Element} elt
     * @param {boolean} err
     * @param {string=} resource
     * @param {string=} redirectedUrl
     */
    receive(url, elt, err, resource, redirectedUrl) {
      this.cache[url] = resource;
      const $p = this.pending[url];
      for (let i = 0, l = $p.length, p;
        (i < l) && (p = $p[i]); i++) {
        // If url was redirected, use the redirected location so paths are
        // calculated relative to that.
        this.onload(url, p, resource, err, redirectedUrl);
        this.tail();
      }
      this.pending[url] = null;
    }

    tail() {
      --this.inflight;
      this.checkDone();
    }

    checkDone() {
      if (!this.inflight) {
        this.oncomplete();
      }
    }
  }

  /********************* importer *********************/

  const isIE = /Trident/.test(navigator.userAgent) ||
    /Edge\/\d./i.test(navigator.userAgent);

  // Used to mark the scripts that need to be cloned in order to be executed.
  const scriptType = 'import-script';

  const scriptsSelector = `
    script:not([type]),
    script[type="application/javascript"],
    script[type="text/javascript"]`;

  const stylesSelector = `
    style:not([type]),
    link[rel=stylesheet][href]:not([type])`;

  const stylesInImportsSelector = `
    ${IMPORT_SELECTOR} style:not([type]),
    ${IMPORT_SELECTOR} link[rel=stylesheet][href]:not([type])`;

  /**
   * @type {Function}
   */
  const MATCHES = Element.prototype.matches ||
    Element.prototype.matchesSelector ||
    Element.prototype.mozMatchesSelector ||
    Element.prototype.msMatchesSelector ||
    Element.prototype.oMatchesSelector ||
    Element.prototype.webkitMatchesSelector;

  /**
   * Importer will:
   * - load any linked import documents (with deduping)
   * - whenever an import is loaded, prompt the parser to try to parse
   * - observe imported documents for new elements (these are handled via the
   *   dynamic importer)
   */
  class Importer {
    constructor() {
      this.documents = {};
      // Make sure to catch any imports that are in the process of loading
      // when this script is run.
      const imports = document.querySelectorAll(IMPORT_SELECTOR);
      for (let i = 0, l = imports.length; i < l; i++) {
        whenElementLoaded(imports[i]);
      }
      // Observe only document head
      new MutationObserver(this._onMutation.bind(this)).observe(document.head, {
        childList: true
      });

      if (!useNative) {
        this._loader = new Loader(
          this._onLoaded.bind(this), this._onLoadedAll.bind(this)
        );
        this.__doc = document.implementation.createHTMLDocument('importer');
        whenDocumentReady(() => this._loadSubtree(document));
      }
    }

    /**
     * @param {!(HTMLElement|Document)} node
     */
    _loadSubtree(node) {
      const nodes = node.querySelectorAll(IMPORT_SELECTOR);
      const count = nodes.length;
      if (count) {
        this._loader.inflight += count;
        for (let i = 0; i < count; i++) {
          // Ensure the load promise is setup.
          whenElementLoaded(nodes[i]);
          this._loader.require(nodes[i]);
        }
        this._loader.checkDone();
      }
    }

    _onLoaded(url, elt, resource, err, redirectedUrl) {
      // We've already seen a document at this url, return.
      if (this.documents[url] !== undefined) {
        return;
      }
      if (err) {
        this.documents[url] = null;
      } else {
        // Generate a document from data.
        const doc = this._makeDocument(resource, redirectedUrl || url);
        // note, we cannot use MO to detect parsed nodes because
        // SD polyfill does not report these as mutations.
        this._loadSubtree(doc);
        this.documents[url] = doc;
      }
    }

    /**
     * Creates a new document containing resource and normalizes urls accordingly.
     * @param {string=} resource
     * @param {string=} url
     * @return {!HTMLElement}
     */
    _makeDocument(resource, url) {
      // Create element from a disconnected document so that resources won't
      // load until we say so.
      const content = /** @type {HTMLElement} */
        (this.__doc.createElement('import-content'));

      content.style.display = 'none';
      if (url) {
        content.setAttribute('import-href', url);
      }
      if (resource) {
        content.innerHTML = resource;
      }

      // Support <base> in imported docs. Resolve url and remove it from the parent.
      const baseEl = /** @type {HTMLBaseElement} */ (content.querySelector('base'));
      if (baseEl) {
        url = Path.replaceAttrUrl(baseEl.getAttribute('href'), url);
        baseEl.parentNode.removeChild(baseEl);
      }

      // This is specific to users of <dom-module> (Polymer).
      // TODO(valdrin) remove this when importForElement is exposed.
      const s$ = content.querySelectorAll('dom-module');
      for (let i = 0, s; i < s$.length && (s = s$[i]); i++) {
        s.setAttribute('assetpath',
          Path.replaceAttrUrl(s.getAttribute('assetpath') || '', url));
      }

      const n$ = content.querySelectorAll(`${IMPORT_SELECTOR},${stylesSelector},${scriptsSelector}`);
      for (let i = 0, l = n$.length, n; i < l && (n = n$[i]); i++) {
        // Ensure we add load/error listeners.
        whenElementLoaded(n);
        Path.fixUrls(n, url);
        if (n.localName === 'script') {
          n['__originalType'] = n.getAttribute('type');
          n.setAttribute('type', scriptType);
        }
      }
      Path.fixUrlsInTemplates(content, url);
      return content;
    }

    _onLoadedAll() {
      const extraStyles = this._flatten();
      // Scripts and styles are executed in sequentially so that styles are
      // applied before scripts run.
      this._waitForStyles(extraStyles)
        .then(() => this._runScripts())
        .then(() => this._fireEvents());
    }

    /**
     * @param {(HTMLElement|Document)=} element
     */
    _flatten(element) {
      const extraStyles = element ? null : [];
      element = element || document;
      const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
        (element.querySelectorAll(IMPORT_SELECTOR));
      for (let i = 0, l = n$.length, n; i < l && (n = n$[i]); i++) {
        n.import = this.documents[n.href];
        if (n.import && !n.import['__firstImport']) {
          n.import['__firstImport'] = n;
          this._flatten(n.import);
          // If in the main document, observe for any imports added later.
          if (element === document) {
            // <link rel=stylesheet> should be appended to <head>. Not doing so
            // in IE/Edge breaks the cascading order
            // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/10472273/
            if (isIE) {
              this._moveStylesToHead(n, extraStyles);
            }
            this._observe(n.import);
          }
          n.appendChild(n.import);
        }
      }
      return extraStyles;
    }

    /**
     * Replaces all the imported scripts with a clone in order to execute them.
     * Updates the `currentScript`.
     * @return {Promise} Resolved when scripts are loaded.
     */
    _runScripts() {
      const s$ = document.querySelectorAll(`script[type=${scriptType}]`);
      let promise = Promise.resolve();
      for (let i = 0, l = s$.length, s; i < l && (s = s$[i]); i++) {
        promise = promise.then(() => {
          const clone = document.createElement('script');

          // Setting `src` will trigger load/error events, so listen for those
          // before setting the attributes. For inline scripts, consider them
          // already loaded.
          let loadedPromise;
          if (s.src) {
            loadedPromise = whenElementLoaded(clone);
          } else {
            clone['__loaded'] = true;
            loadedPromise = Promise.resolve(clone);
          }

          // Copy attributes and textContent.
          for (let j = 0, ll = s.attributes.length; j < ll; j++) {
            const attr = s.attributes[j];
            if (attr.name === 'type') {
              clone.setAttribute(attr.name, s['__originalType'] || 'text/javascript');
            } else {
              clone.setAttribute(attr.name, attr.value);
            }
          }
          clone.textContent = s.textContent;

          // Update currentScript and replace original with clone script.
          currentScript = clone;
          s.parentNode.replaceChild(clone, s);
          // Listen for load/error events before adding the clone to the document.
          // After is loaded, reset currentScript.
          return loadedPromise.then(() => currentScript = null);
        });
      }
      return promise;
    }

    /**
     * Waits for all the imported stylesheets/styles to be loaded.
     * @return {Promise}
     */
    _waitForStyles(extraStyles) {
      const s$ = document.querySelectorAll(stylesInImportsSelector);
      const promises = [];
      for (let i = 0; i < s$.length; i++) {
        promises.push(whenElementLoaded(s$[i]));
      }
      for (let i = 0; i < extraStyles.length; i++) {
        promises.push(whenElementLoaded(extraStyles[i]));
      }
      return Promise.all(promises);
    }

    /**
     * Moves <link rel=stylesheet> and <style> elements contained in imports to
     * <head>.
     * @param {!HTMLLinkElement} importLink
     */
    _moveStylesToHead(importLink, extraStyles) {
      const n$ = importLink.import.querySelectorAll(stylesSelector);
      for (let i = 0, l = n$.length, n; i < l && (n = n$[i]); i++) {
        if (importLink.parentNode === document.head) {
          document.head.insertBefore(n, importLink);
        } else {
          document.head.appendChild(n);
        }
        if (n.localName === 'style') {
          n.textContent += ''
        }
        extraStyles.push(n);
      }
    }

    /**
     * Fires load/error events for loaded imports.
     */
    _fireEvents() {
      const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
        (document.querySelectorAll(IMPORT_SELECTOR));
      // Inverse order to have events firing bottom-up.
      for (let i = n$.length - 1, n; i >= 0 && (n = n$[i]); i--) {
        // Don't fire twice same event.
        if (!n['__fired']) {
          n['__fired'] = true;
          const eventType = n.import ? 'load' : 'error';
          n.dispatchEvent(new CustomEvent(eventType, {
            bubbles: false,
            cancelable: false,
            detail: undefined
          }));
        }
      }
    }

    _observe(element) {
      if (element['__importObserver']) {
        return;
      }
      element['__importObserver'] = new MutationObserver(this._onMutation.bind(this));
      element['__importObserver'].observe(element, {
        childList: true,
        subtree: true
      });
    }

    /**
     * @param {Array<MutationRecord>} mutations
     */
    _onMutation(mutations) {
      for (let j = 0, m; j < mutations.length && (m = mutations[j]); j++) {
        for (let i = 0, l = m.addedNodes ? m.addedNodes.length : 0; i < l; i++) {
          const n = /** @type {Element} */ (m.addedNodes[i]);
          if (n && isImportLink(n)) {
            whenElementLoaded(n);
            if (!useNative) {
              this._loader.addNode(n);
            }
          }
        }
      }
    }

  }

  /**
   * @param {!Node} node
   * @return {boolean}
   */
  function isImportLink(node) {
    return node.nodeType === Node.ELEMENT_NODE && MATCHES.call(node, IMPORT_SELECTOR);
  }

  /**
   * Waits for an element to finish loading. If already done loading, it will
   * mark the element accordingly.
   * @param {!Element} element
   * @return {Promise}
   */
  function whenElementLoaded(element) {
    if (!element['__loadPromise']) {
      element['__loadPromise'] = new Promise((resolve) => {
        if (isElementLoaded(element)) {
          resolve();
        } else {
          element.addEventListener('load', resolve);
          element.addEventListener('error', resolve);
          if (isIE && element.localName === 'style') {
            // NOTE: IE does not fire "load" event for styles that have already
            // loaded. This is in violation of the spec, so we try our hardest
            // to work around it.
            let fakeLoad = false;
            // If there's not @import in the textContent, assume it has loaded
            if (element.textContent.indexOf('@import') === -1) {
              fakeLoad = true;
            }
            // if we have a sheet, we have been parsed.
            else if (element.sheet) {
              fakeLoad = true;
              const csr = element.sheet.cssRules;
              // search the rules for @import's
              for (let i = 0, l = csr ? csr.length : 0; i < l && fakeLoad; i++) {
                if (csr[i].type === CSSRule.IMPORT_RULE) {
                  // if every @import has resolved, fake the load
                  fakeLoad = Boolean(csr[i].styleSheet);
                }
              }
            }
            // Dispatch a fake load event and continue parsing
            if (fakeLoad) {
              // Fire async, to prevent reentrancy
              setTimeout(() => element.dispatchEvent(new CustomEvent('load', {
                cancelable: false,
                bubbles: false,
                detail: undefined
              })));
            }
          }
        }
      }).then(() => {
        element['__loaded'] = true;
        return element;
      });
    }
    return element['__loadPromise'];
  }

  /**
   * @param {!Element} element
   * @return {boolean}
   */
  function isElementLoaded(element) {
    if (element['__loaded']) {
      return true;
    }
    let isLoaded = false;
    if (useNative && isImportLink(element) &&
      element.import && element.import.readyState !== 'loading') {
      isLoaded = true;
    }
    element['__loaded'] = isLoaded;
    return isLoaded;
  }

  /**
   * Calls the callback when all imports in the document at call time
   * (or at least document ready) have loaded. Callback is called synchronously
   * if imports are already done loading.
   * @param {function()=} callback
   */
  function whenReady(callback) {
    // 1. ensure the document is in a ready state (has dom), then
    // 2. watch for loading of imports and call callback when done
    whenDocumentReady(() => whenImportsReady(() => callback && callback()));
  }

  /**
   * Invokes the callback when document is in ready state. Callback is called
   *  synchronously if document is already done loading.
   * @param {!function()} callback
   */
  function whenDocumentReady(callback) {
    if (document.readyState !== 'loading') {
      callback();
    } else {
      document.addEventListener('readystatechange', function stateChanged() {
        if (document.readyState !== 'loading') {
          document.removeEventListener('readystatechange', stateChanged);
          callback();
        }
      });
    }
  }

  /**
   * Invokes the callback after all imports are loaded. Callback is called
   * synchronously if imports are already done loading.
   * @param {!function()} callback
   */
  function whenImportsReady(callback) {
    let imports = document.querySelectorAll(IMPORT_SELECTOR);
    const promises = [];
    for (let i = 0, l = imports.length, imp; i < l && (imp = imports[i]); i++) {
      // Skip nested imports.
      if (MATCHES.call(imp, `${IMPORT_SELECTOR} ${IMPORT_SELECTOR}`)) {
        continue;
      }
      if (!isElementLoaded(imp)) {
        promises.push(whenElementLoaded(imp));
      }
    }
    if (promises.length) {
      Promise.all(promises).then(() => callback());
    } else {
      callback();
    }
  }

  /**
    Add support for the `HTMLImportsLoaded` event and the `HTMLImports.whenReady`
    method. This api is necessary because unlike the native implementation,
    script elements do not force imports to resolve. Instead, users should wrap
    code in either an `HTMLImportsLoaded` handler or after load time in an
    `HTMLImports.whenReady(callback)` call.

    NOTE: This module also supports these apis under the native implementation.
    Therefore, if this file is loaded, the same code can be used under both
    the polyfill and native implementation.
   */
  whenReady(() => document.dispatchEvent(new CustomEvent('HTMLImportsLoaded', {
    cancelable: true,
    bubbles: true,
    detail: undefined
  })));

  new Importer();

  // exports
  scope.useNative = useNative;
  scope.whenReady = whenReady;

})(window.HTMLImports = (window.HTMLImports || {}));
