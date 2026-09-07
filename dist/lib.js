import { createRequire } from "node:module";
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS((exports) => {
  var ALIAS = Symbol.for("yaml.alias");
  var DOC = Symbol.for("yaml.document");
  var MAP = Symbol.for("yaml.map");
  var PAIR = Symbol.for("yaml.pair");
  var SCALAR = Symbol.for("yaml.scalar");
  var SEQ = Symbol.for("yaml.seq");
  var NODE_TYPE = Symbol.for("yaml.node.type");
  var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
  var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
  var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
  var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
  var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
  var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
  function isCollection(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case MAP:
        case SEQ:
          return true;
      }
    return false;
  }
  function isNode(node) {
    if (node && typeof node === "object")
      switch (node[NODE_TYPE]) {
        case ALIAS:
        case MAP:
        case SCALAR:
        case SEQ:
          return true;
      }
    return false;
  }
  var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
  exports.ALIAS = ALIAS;
  exports.DOC = DOC;
  exports.MAP = MAP;
  exports.NODE_TYPE = NODE_TYPE;
  exports.PAIR = PAIR;
  exports.SCALAR = SCALAR;
  exports.SEQ = SEQ;
  exports.hasAnchor = hasAnchor;
  exports.isAlias = isAlias;
  exports.isCollection = isCollection;
  exports.isDocument = isDocument;
  exports.isMap = isMap;
  exports.isNode = isNode;
  exports.isPair = isPair;
  exports.isScalar = isScalar;
  exports.isSeq = isSeq;
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS((exports) => {
  var identity = require_identity();
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove node");
  function visit(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      visit_(null, node, visitor_, Object.freeze([]));
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  function visit_(key, node, visitor, path) {
    const ctrl = callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visit_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = visit_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = visit_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = visit_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  async function visitAsync(node, visitor) {
    const visitor_ = initVisitor(visitor);
    if (identity.isDocument(node)) {
      const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
      if (cd === REMOVE)
        node.contents = null;
    } else
      await visitAsync_(null, node, visitor_, Object.freeze([]));
  }
  visitAsync.BREAK = BREAK;
  visitAsync.SKIP = SKIP;
  visitAsync.REMOVE = REMOVE;
  async function visitAsync_(key, node, visitor, path) {
    const ctrl = await callVisitor(key, node, visitor, path);
    if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
      replaceNode(key, path, ctrl);
      return visitAsync_(key, ctrl, visitor, path);
    }
    if (typeof ctrl !== "symbol") {
      if (identity.isCollection(node)) {
        path = Object.freeze(path.concat(node));
        for (let i = 0;i < node.items.length; ++i) {
          const ci = await visitAsync_(i, node.items[i], visitor, path);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            node.items.splice(i, 1);
            i -= 1;
          }
        }
      } else if (identity.isPair(node)) {
        path = Object.freeze(path.concat(node));
        const ck = await visitAsync_("key", node.key, visitor, path);
        if (ck === BREAK)
          return BREAK;
        else if (ck === REMOVE)
          node.key = null;
        const cv = await visitAsync_("value", node.value, visitor, path);
        if (cv === BREAK)
          return BREAK;
        else if (cv === REMOVE)
          node.value = null;
      }
    }
    return ctrl;
  }
  function initVisitor(visitor) {
    if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
      return Object.assign({
        Alias: visitor.Node,
        Map: visitor.Node,
        Scalar: visitor.Node,
        Seq: visitor.Node
      }, visitor.Value && {
        Map: visitor.Value,
        Scalar: visitor.Value,
        Seq: visitor.Value
      }, visitor.Collection && {
        Map: visitor.Collection,
        Seq: visitor.Collection
      }, visitor);
    }
    return visitor;
  }
  function callVisitor(key, node, visitor, path) {
    if (typeof visitor === "function")
      return visitor(key, node, path);
    if (identity.isMap(node))
      return visitor.Map?.(key, node, path);
    if (identity.isSeq(node))
      return visitor.Seq?.(key, node, path);
    if (identity.isPair(node))
      return visitor.Pair?.(key, node, path);
    if (identity.isScalar(node))
      return visitor.Scalar?.(key, node, path);
    if (identity.isAlias(node))
      return visitor.Alias?.(key, node, path);
    return;
  }
  function replaceNode(key, path, node) {
    const parent = path[path.length - 1];
    if (identity.isCollection(parent)) {
      parent.items[key] = node;
    } else if (identity.isPair(parent)) {
      if (key === "key")
        parent.key = node;
      else
        parent.value = node;
    } else if (identity.isDocument(parent)) {
      parent.contents = node;
    } else {
      const pt = identity.isAlias(parent) ? "alias" : "scalar";
      throw new Error(`Cannot replace node with ${pt} parent`);
    }
  }
  exports.visit = visit;
  exports.visitAsync = visitAsync;
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  var escapeChars = {
    "!": "%21",
    ",": "%2C",
    "[": "%5B",
    "]": "%5D",
    "{": "%7B",
    "}": "%7D"
  };
  var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);

  class Directives {
    constructor(yaml, tags) {
      this.docStart = null;
      this.docEnd = false;
      this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
      this.tags = Object.assign({}, Directives.defaultTags, tags);
    }
    clone() {
      const copy = new Directives(this.yaml, this.tags);
      copy.docStart = this.docStart;
      return copy;
    }
    atDocument() {
      const res = new Directives(this.yaml, this.tags);
      switch (this.yaml.version) {
        case "1.1":
          this.atNextDocument = true;
          break;
        case "1.2":
          this.atNextDocument = false;
          this.yaml = {
            explicit: Directives.defaultYaml.explicit,
            version: "1.2"
          };
          this.tags = Object.assign({}, Directives.defaultTags);
          break;
      }
      return res;
    }
    add(line, onError) {
      if (this.atNextDocument) {
        this.yaml = { explicit: Directives.defaultYaml.explicit, version: "1.1" };
        this.tags = Object.assign({}, Directives.defaultTags);
        this.atNextDocument = false;
      }
      const parts = line.trim().split(/[ \t]+/);
      const name = parts.shift();
      switch (name) {
        case "%TAG": {
          if (parts.length !== 2) {
            onError(0, "%TAG directive should contain exactly two parts");
            if (parts.length < 2)
              return false;
          }
          const [handle, prefix] = parts;
          this.tags[handle] = prefix;
          return true;
        }
        case "%YAML": {
          this.yaml.explicit = true;
          if (parts.length !== 1) {
            onError(0, "%YAML directive should contain exactly one part");
            return false;
          }
          const [version] = parts;
          if (version === "1.1" || version === "1.2") {
            this.yaml.version = version;
            return true;
          } else {
            const isValid2 = /^\d+\.\d+$/.test(version);
            onError(6, `Unsupported YAML version ${version}`, isValid2);
            return false;
          }
        }
        default:
          onError(0, `Unknown directive ${name}`, true);
          return false;
      }
    }
    tagName(source, onError) {
      if (source === "!")
        return "!";
      if (source[0] !== "!") {
        onError(`Not a valid tag: ${source}`);
        return null;
      }
      if (source[1] === "<") {
        const verbatim = source.slice(2, -1);
        if (verbatim === "!" || verbatim === "!!") {
          onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
          return null;
        }
        if (source[source.length - 1] !== ">")
          onError("Verbatim tags must end with a >");
        return verbatim;
      }
      const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
      if (!suffix)
        onError(`The ${source} tag has no suffix`);
      const prefix = this.tags[handle];
      if (prefix) {
        try {
          return prefix + decodeURIComponent(suffix);
        } catch (error) {
          onError(String(error));
          return null;
        }
      }
      if (handle === "!")
        return source;
      onError(`Could not resolve tag: ${source}`);
      return null;
    }
    tagString(tag) {
      for (const [handle, prefix] of Object.entries(this.tags)) {
        if (tag.startsWith(prefix))
          return handle + escapeTagName(tag.substring(prefix.length));
      }
      return tag[0] === "!" ? tag : `!<${tag}>`;
    }
    toString(doc) {
      const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
      const tagEntries = Object.entries(this.tags);
      let tagNames;
      if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
        const tags = {};
        visit.visit(doc.contents, (_key, node) => {
          if (identity.isNode(node) && node.tag)
            tags[node.tag] = true;
        });
        tagNames = Object.keys(tags);
      } else
        tagNames = [];
      for (const [handle, prefix] of tagEntries) {
        if (handle === "!!" && prefix === "tag:yaml.org,2002:")
          continue;
        if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
          lines.push(`%TAG ${handle} ${prefix}`);
      }
      return lines.join(`
`);
    }
  }
  Directives.defaultYaml = { explicit: false, version: "1.2" };
  Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
  exports.Directives = Directives;
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS((exports) => {
  var identity = require_identity();
  var visit = require_visit();
  function anchorIsValid(anchor) {
    if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
      const sa = JSON.stringify(anchor);
      const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
      throw new Error(msg);
    }
    return true;
  }
  function anchorNames(root) {
    const anchors = new Set;
    visit.visit(root, {
      Value(_key, node) {
        if (node.anchor)
          anchors.add(node.anchor);
      }
    });
    return anchors;
  }
  function findNewAnchor(prefix, exclude) {
    for (let i = 1;; ++i) {
      const name = `${prefix}${i}`;
      if (!exclude.has(name))
        return name;
    }
  }
  function createNodeAnchors(doc, prefix) {
    const aliasObjects = [];
    const sourceObjects = new Map;
    let prevAnchors = null;
    return {
      onAnchor: (source) => {
        aliasObjects.push(source);
        prevAnchors ?? (prevAnchors = anchorNames(doc));
        const anchor = findNewAnchor(prefix, prevAnchors);
        prevAnchors.add(anchor);
        return anchor;
      },
      setAnchors: () => {
        for (const source of aliasObjects) {
          const ref = sourceObjects.get(source);
          if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
            ref.node.anchor = ref.anchor;
          } else {
            const error = new Error("Failed to resolve repeated object (this should not happen)");
            error.source = source;
            throw error;
          }
        }
      },
      sourceObjects
    };
  }
  exports.anchorIsValid = anchorIsValid;
  exports.anchorNames = anchorNames;
  exports.createNodeAnchors = createNodeAnchors;
  exports.findNewAnchor = findNewAnchor;
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS((exports) => {
  function applyReviver(reviver, obj, key, val) {
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (let i = 0, len = val.length;i < len; ++i) {
          const v0 = val[i];
          const v1 = applyReviver(reviver, val, String(i), v0);
          if (v1 === undefined)
            delete val[i];
          else if (v1 !== v0)
            val[i] = v1;
        }
      } else if (val instanceof Map) {
        for (const k of Array.from(val.keys())) {
          const v0 = val.get(k);
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            val.delete(k);
          else if (v1 !== v0)
            val.set(k, v1);
        }
      } else if (val instanceof Set) {
        for (const v0 of Array.from(val)) {
          const v1 = applyReviver(reviver, val, v0, v0);
          if (v1 === undefined)
            val.delete(v0);
          else if (v1 !== v0) {
            val.delete(v0);
            val.add(v1);
          }
        }
      } else {
        for (const [k, v0] of Object.entries(val)) {
          const v1 = applyReviver(reviver, val, k, v0);
          if (v1 === undefined)
            delete val[k];
          else if (v1 !== v0)
            val[k] = v1;
        }
      }
    }
    return reviver.call(obj, key, val);
  }
  exports.applyReviver = applyReviver;
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS((exports) => {
  var identity = require_identity();
  function toJS(value, arg, ctx) {
    if (Array.isArray(value))
      return value.map((v, i) => toJS(v, String(i), ctx));
    if (value && typeof value.toJSON === "function") {
      if (!ctx || !identity.hasAnchor(value))
        return value.toJSON(arg, ctx);
      const data = { aliasCount: 0, count: 1, res: undefined };
      ctx.anchors.set(value, data);
      ctx.onCreate = (res2) => {
        data.res = res2;
        delete ctx.onCreate;
      };
      const res = value.toJSON(arg, ctx);
      if (ctx.onCreate)
        ctx.onCreate(res);
      return res;
    }
    if (typeof value === "bigint" && !ctx?.keep)
      return Number(value);
    return value;
  }
  exports.toJS = toJS;
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS((exports) => {
  var applyReviver = require_applyReviver();
  var identity = require_identity();
  var toJS = require_toJS();

  class NodeBase {
    constructor(type) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: type });
    }
    clone() {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      if (!identity.isDocument(doc))
        throw new TypeError("A document argument is required");
      const ctx = {
        anchors: new Map,
        doc,
        keep: true,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this, "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
  }
  exports.NodeBase = NodeBase;
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS((exports) => {
  var anchors = require_anchors();
  var visit = require_visit();
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();

  class Alias extends Node.NodeBase {
    constructor(source) {
      super(identity.ALIAS);
      this.source = source;
      Object.defineProperty(this, "tag", {
        set() {
          throw new Error("Alias nodes cannot have tags");
        }
      });
    }
    resolve(doc, ctx) {
      if (ctx?.maxAliasCount === 0)
        throw new ReferenceError("Alias resolution is disabled");
      let nodes;
      if (ctx?.aliasResolveCache) {
        nodes = ctx.aliasResolveCache;
      } else {
        nodes = [];
        visit.visit(doc, {
          Node: (_key, node) => {
            if (identity.isAlias(node) || identity.hasAnchor(node))
              nodes.push(node);
          }
        });
        if (ctx)
          ctx.aliasResolveCache = nodes;
      }
      let found = undefined;
      for (const node of nodes) {
        if (node === this)
          break;
        if (node.anchor === this.source)
          found = node;
      }
      return found;
    }
    toJSON(_arg, ctx) {
      if (!ctx)
        return { source: this.source };
      const { anchors: anchors2, doc, maxAliasCount } = ctx;
      const source = this.resolve(doc, ctx);
      if (!source) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new ReferenceError(msg);
      }
      let data = anchors2.get(source);
      if (!data) {
        toJS.toJS(source, null, ctx);
        data = anchors2.get(source);
      }
      if (data?.res === undefined) {
        const msg = "This should not happen: Alias anchor was not resolved?";
        throw new ReferenceError(msg);
      }
      if (maxAliasCount >= 0) {
        data.count += 1;
        if (data.aliasCount === 0)
          data.aliasCount = getAliasCount(doc, source, anchors2);
        if (data.count * data.aliasCount > maxAliasCount) {
          const msg = "Excessive alias count indicates a resource exhaustion attack";
          throw new ReferenceError(msg);
        }
      }
      return data.res;
    }
    toString(ctx, _onComment, _onChompKeep) {
      const src = `*${this.source}`;
      if (ctx) {
        anchors.anchorIsValid(this.source);
        if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new Error(msg);
        }
        if (ctx.implicitKey)
          return `${src} `;
      }
      return src;
    }
  }
  function getAliasCount(doc, node, anchors2) {
    if (identity.isAlias(node)) {
      const source = node.resolve(doc);
      const anchor = anchors2 && source && anchors2.get(source);
      return anchor ? anchor.count * anchor.aliasCount : 0;
    } else if (identity.isCollection(node)) {
      let count = 0;
      for (const item of node.items) {
        const c = getAliasCount(doc, item, anchors2);
        if (c > count)
          count = c;
      }
      return count;
    } else if (identity.isPair(node)) {
      const kc = getAliasCount(doc, node.key, anchors2);
      const vc = getAliasCount(doc, node.value, anchors2);
      return Math.max(kc, vc);
    }
    return 1;
  }
  exports.Alias = Alias;
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Node = require_Node();
  var toJS = require_toJS();
  var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";

  class Scalar extends Node.NodeBase {
    constructor(value) {
      super(identity.SCALAR);
      this.value = value;
    }
    toJSON(arg, ctx) {
      return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
    }
    toString() {
      return String(this.value);
    }
  }
  Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
  Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
  Scalar.PLAIN = "PLAIN";
  Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
  Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
  exports.Scalar = Scalar;
  exports.isScalarValue = isScalarValue;
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var defaultTagPrefix = "tag:yaml.org,2002:";
  function findTagObject(value, tagName, tags) {
    if (tagName) {
      const match = tags.filter((t) => t.tag === tagName);
      const tagObj = match.find((t) => !t.format) ?? match[0];
      if (!tagObj)
        throw new Error(`Tag ${tagName} not found`);
      return tagObj;
    }
    return tags.find((t) => t.identify?.(value) && !t.format);
  }
  function createNode(value, tagName, ctx) {
    if (identity.isDocument(value))
      value = value.contents;
    if (identity.isNode(value))
      return value;
    if (identity.isPair(value)) {
      const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
      map.items.push(value);
      return map;
    }
    if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
      value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === "object") {
      ref = sourceObjects.get(value);
      if (ref) {
        ref.anchor ?? (ref.anchor = onAnchor(value));
        return new Alias.Alias(ref.anchor);
      } else {
        ref = { anchor: null, node: null };
        sourceObjects.set(value, ref);
      }
    }
    if (tagName?.startsWith("!!"))
      tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
      if (value && typeof value.toJSON === "function") {
        value = value.toJSON();
      }
      if (!value || typeof value !== "object") {
        const node2 = new Scalar.Scalar(value);
        if (ref)
          ref.node = node2;
        return node2;
      }
      tagObj = value instanceof Map ? schema[identity.MAP] : (Symbol.iterator in Object(value)) ? schema[identity.SEQ] : schema[identity.MAP];
    }
    if (onTagObj) {
      onTagObj(tagObj);
      delete ctx.onTagObj;
    }
    const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
    if (tagName)
      node.tag = tagName;
    else if (!tagObj.default)
      node.tag = tagObj.tag;
    if (ref)
      ref.node = node;
    return node;
  }
  exports.createNode = createNode;
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS((exports) => {
  var createNode = require_createNode();
  var identity = require_identity();
  var Node = require_Node();
  function collectionFromPath(schema, path, value) {
    let v = value;
    for (let i = path.length - 1;i >= 0; --i) {
      const k = path[i];
      if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
        const a = [];
        a[k] = v;
        v = a;
      } else {
        v = new Map([[k, v]]);
      }
    }
    return createNode.createNode(v, undefined, {
      aliasDuplicateObjects: false,
      keepUndefined: false,
      onAnchor: () => {
        throw new Error("This should not happen, please report a bug.");
      },
      schema,
      sourceObjects: new Map
    });
  }
  var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;

  class Collection extends Node.NodeBase {
    constructor(type, schema) {
      super(type);
      Object.defineProperty(this, "schema", {
        value: schema,
        configurable: true,
        enumerable: false,
        writable: true
      });
    }
    clone(schema) {
      const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
      if (schema)
        copy.schema = schema;
      copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    addIn(path, value) {
      if (isEmptyPath(path))
        this.add(value);
      else {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.addIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
    deleteIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.delete(key);
      const node = this.get(key, true);
      if (identity.isCollection(node))
        return node.deleteIn(rest);
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
    getIn(path, keepScalar) {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (rest.length === 0)
        return !keepScalar && identity.isScalar(node) ? node.value : node;
      else
        return identity.isCollection(node) ? node.getIn(rest, keepScalar) : undefined;
    }
    hasAllNullValues(allowScalar) {
      return this.items.every((node) => {
        if (!identity.isPair(node))
          return false;
        const n = node.value;
        return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
      });
    }
    hasIn(path) {
      const [key, ...rest] = path;
      if (rest.length === 0)
        return this.has(key);
      const node = this.get(key, true);
      return identity.isCollection(node) ? node.hasIn(rest) : false;
    }
    setIn(path, value) {
      const [key, ...rest] = path;
      if (rest.length === 0) {
        this.set(key, value);
      } else {
        const node = this.get(key, true);
        if (identity.isCollection(node))
          node.setIn(rest, value);
        else if (node === undefined && this.schema)
          this.set(key, collectionFromPath(this.schema, rest, value));
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
    }
  }
  exports.Collection = Collection;
  exports.collectionFromPath = collectionFromPath;
  exports.isEmptyPath = isEmptyPath;
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS((exports) => {
  var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
  function indentComment(comment, indent) {
    if (/^\n+$/.test(comment))
      return comment.substring(1);
    return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
  }
  var lineComment = (str, indent, comment) => str.endsWith(`
`) ? indentComment(comment, indent) : comment.includes(`
`) ? `
` + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
  exports.indentComment = indentComment;
  exports.lineComment = lineComment;
  exports.stringifyComment = stringifyComment;
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS((exports) => {
  var FOLD_FLOW = "flow";
  var FOLD_BLOCK = "block";
  var FOLD_QUOTED = "quoted";
  function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
    if (!lineWidth || lineWidth < 0)
      return text;
    if (lineWidth < minContentWidth)
      minContentWidth = 0;
    const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
    if (text.length <= endStep)
      return text;
    const folds = [];
    const escapedFolds = {};
    let end = lineWidth - indent.length;
    if (typeof indentAtStart === "number") {
      if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
        folds.push(0);
      else
        end = lineWidth - indentAtStart;
    }
    let split = undefined;
    let prev = undefined;
    let overflow = false;
    let i = -1;
    let escStart = -1;
    let escEnd = -1;
    if (mode === FOLD_BLOCK) {
      i = consumeMoreIndentedLines(text, i, indent.length);
      if (i !== -1)
        end = i + endStep;
    }
    for (let ch;ch = text[i += 1]; ) {
      if (mode === FOLD_QUOTED && ch === "\\") {
        escStart = i;
        switch (text[i + 1]) {
          case "x":
            i += 3;
            break;
          case "u":
            i += 5;
            break;
          case "U":
            i += 9;
            break;
          default:
            i += 1;
        }
        escEnd = i;
      }
      if (ch === `
`) {
        if (mode === FOLD_BLOCK)
          i = consumeMoreIndentedLines(text, i, indent.length);
        end = i + indent.length + endStep;
        split = undefined;
      } else {
        if (ch === " " && prev && prev !== " " && prev !== `
` && prev !== "\t") {
          const next = text[i + 1];
          if (next && next !== " " && next !== `
` && next !== "\t")
            split = i;
        }
        if (i >= end) {
          if (split) {
            folds.push(split);
            end = split + endStep;
            split = undefined;
          } else if (mode === FOLD_QUOTED) {
            while (prev === " " || prev === "\t") {
              prev = ch;
              ch = text[i += 1];
              overflow = true;
            }
            const j = i > escEnd + 1 ? i - 2 : escStart - 1;
            if (escapedFolds[j])
              return text;
            folds.push(j);
            escapedFolds[j] = true;
            end = j + endStep;
            split = undefined;
          } else {
            overflow = true;
          }
        }
      }
      prev = ch;
    }
    if (overflow && onOverflow)
      onOverflow();
    if (folds.length === 0)
      return text;
    if (onFold)
      onFold();
    let res = text.slice(0, folds[0]);
    for (let i2 = 0;i2 < folds.length; ++i2) {
      const fold = folds[i2];
      const end2 = folds[i2 + 1] || text.length;
      if (fold === 0)
        res = `
${indent}${text.slice(0, end2)}`;
      else {
        if (mode === FOLD_QUOTED && escapedFolds[fold])
          res += `${text[fold]}\\`;
        res += `
${indent}${text.slice(fold + 1, end2)}`;
      }
    }
    return res;
  }
  function consumeMoreIndentedLines(text, i, indent) {
    let end = i;
    let start = i + 1;
    let ch = text[start];
    while (ch === " " || ch === "\t") {
      if (i < start + indent) {
        ch = text[++i];
      } else {
        do {
          ch = text[++i];
        } while (ch && ch !== `
`);
        end = i;
        start = i + 1;
        ch = text[start];
      }
    }
    return end;
  }
  exports.FOLD_BLOCK = FOLD_BLOCK;
  exports.FOLD_FLOW = FOLD_FLOW;
  exports.FOLD_QUOTED = FOLD_QUOTED;
  exports.foldFlowLines = foldFlowLines;
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var foldFlowLines = require_foldFlowLines();
  var getFoldOptions = (ctx, isBlock) => ({
    indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
    lineWidth: ctx.options.lineWidth,
    minContentWidth: ctx.options.minContentWidth
  });
  var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
  function lineLengthOverLimit(str, lineWidth, indentLength) {
    if (!lineWidth || lineWidth < 0)
      return false;
    const limit = lineWidth - indentLength;
    const strLen = str.length;
    if (strLen <= limit)
      return false;
    for (let i = 0, start = 0;i < strLen; ++i) {
      if (str[i] === `
`) {
        if (i - start > limit)
          return true;
        start = i + 1;
        if (strLen - start <= limit)
          return false;
      }
    }
    return true;
  }
  function doubleQuotedString(value, ctx) {
    const json = JSON.stringify(value);
    if (ctx.options.doubleQuotedAsJSON)
      return json;
    const { implicitKey } = ctx;
    const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    let str = "";
    let start = 0;
    for (let i = 0, ch = json[i];ch; ch = json[++i]) {
      if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
        str += json.slice(start, i) + "\\ ";
        i += 1;
        start = i;
        ch = "\\";
      }
      if (ch === "\\")
        switch (json[i + 1]) {
          case "u":
            {
              str += json.slice(start, i);
              const code = json.substr(i + 2, 4);
              switch (code) {
                case "0000":
                  str += "\\0";
                  break;
                case "0007":
                  str += "\\a";
                  break;
                case "000b":
                  str += "\\v";
                  break;
                case "001b":
                  str += "\\e";
                  break;
                case "0085":
                  str += "\\N";
                  break;
                case "00a0":
                  str += "\\_";
                  break;
                case "2028":
                  str += "\\L";
                  break;
                case "2029":
                  str += "\\P";
                  break;
                default:
                  if (code.substr(0, 2) === "00")
                    str += "\\x" + code.substr(2);
                  else
                    str += json.substr(i, 6);
              }
              i += 5;
              start = i + 1;
            }
            break;
          case "n":
            if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
              i += 1;
            } else {
              str += json.slice(start, i) + `

`;
              while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                str += `
`;
                i += 2;
              }
              str += indent;
              if (json[i + 2] === " ")
                str += "\\";
              i += 1;
              start = i + 1;
            }
            break;
          default:
            i += 1;
        }
    }
    str = start ? str + json.slice(start) : json;
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
  }
  function singleQuotedString(value, ctx) {
    if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes(`
`) || /[ \t]\n|\n[ \t]/.test(value))
      return doubleQuotedString(value, ctx);
    const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
    const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
    return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function quotedString(value, ctx) {
    const { singleQuote } = ctx.options;
    let qs;
    if (singleQuote === false)
      qs = doubleQuotedString;
    else {
      const hasDouble = value.includes('"');
      const hasSingle = value.includes("'");
      if (hasDouble && !hasSingle)
        qs = singleQuotedString;
      else if (hasSingle && !hasDouble)
        qs = doubleQuotedString;
      else
        qs = singleQuote ? singleQuotedString : doubleQuotedString;
    }
    return qs(value, ctx);
  }
  var blockEndNewlines;
  try {
    blockEndNewlines = new RegExp(`(^|(?<!
))
+(?!
|$)`, "g");
  } catch {
    blockEndNewlines = /\n+(?!\n|$)/g;
  }
  function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
    const { blockQuote, commentString, lineWidth } = ctx.options;
    if (!blockQuote || /\n[\t ]+$/.test(value)) {
      return quotedString(value, ctx);
    }
    const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
    const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
    if (!value)
      return literal ? `|
` : `>
`;
    let chomp;
    let endStart;
    for (endStart = value.length;endStart > 0; --endStart) {
      const ch = value[endStart - 1];
      if (ch !== `
` && ch !== "\t" && ch !== " ")
        break;
    }
    let end = value.substring(endStart);
    const endNlPos = end.indexOf(`
`);
    if (endNlPos === -1) {
      chomp = "-";
    } else if (value === end || endNlPos !== end.length - 1) {
      chomp = "+";
      if (onChompKeep)
        onChompKeep();
    } else {
      chomp = "";
    }
    if (end) {
      value = value.slice(0, -end.length);
      if (end[end.length - 1] === `
`)
        end = end.slice(0, -1);
      end = end.replace(blockEndNewlines, `$&${indent}`);
    }
    let startWithSpace = false;
    let startEnd;
    let startNlPos = -1;
    for (startEnd = 0;startEnd < value.length; ++startEnd) {
      const ch = value[startEnd];
      if (ch === " ")
        startWithSpace = true;
      else if (ch === `
`)
        startNlPos = startEnd;
      else
        break;
    }
    let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
    if (start) {
      value = value.substring(start.length);
      start = start.replace(/\n+/g, `$&${indent}`);
    }
    const indentSize = indent ? "2" : "1";
    let header = (startWithSpace ? indentSize : "") + chomp;
    if (comment) {
      header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
      if (onComment)
        onComment();
    }
    if (!literal) {
      const foldedValue = value.replace(/\n+/g, `
$&`).replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
      let literalFallback = false;
      const foldOptions = getFoldOptions(ctx, true);
      if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
        foldOptions.onOverflow = () => {
          literalFallback = true;
        };
      }
      const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
      if (!literalFallback)
        return `>${header}
${indent}${body}`;
    }
    value = value.replace(/\n+/g, `$&${indent}`);
    return `|${header}
${indent}${start}${value}${end}`;
  }
  function plainString(item, ctx, onComment, onChompKeep) {
    const { type, value } = item;
    const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
    if (implicitKey && value.includes(`
`) || inFlow && /[[\]{},]/.test(value)) {
      return quotedString(value, ctx);
    }
    if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
      return implicitKey || inFlow || !value.includes(`
`) ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
    }
    if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes(`
`)) {
      return blockString(item, ctx, onComment, onChompKeep);
    }
    if (containsDocumentMarker(value)) {
      if (indent === "") {
        ctx.forceBlockIndent = true;
        return blockString(item, ctx, onComment, onChompKeep);
      } else if (implicitKey && indent === indentStep) {
        return quotedString(value, ctx);
      }
    }
    const str = value.replace(/\n+/g, `$&
${indent}`);
    if (actualString) {
      const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
      const { compat, tags } = ctx.doc.schema;
      if (tags.some(test) || compat?.some(test))
        return quotedString(value, ctx);
    }
    return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
  }
  function stringifyString(item, ctx, onComment, onChompKeep) {
    const { implicitKey, inFlow } = ctx;
    const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
    let { type } = item;
    if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
        type = Scalar.Scalar.QUOTE_DOUBLE;
    }
    const _stringify = (_type) => {
      switch (_type) {
        case Scalar.Scalar.BLOCK_FOLDED:
        case Scalar.Scalar.BLOCK_LITERAL:
          return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
        case Scalar.Scalar.QUOTE_DOUBLE:
          return doubleQuotedString(ss.value, ctx);
        case Scalar.Scalar.QUOTE_SINGLE:
          return singleQuotedString(ss.value, ctx);
        case Scalar.Scalar.PLAIN:
          return plainString(ss, ctx, onComment, onChompKeep);
        default:
          return null;
      }
    };
    let res = _stringify(type);
    if (res === null) {
      const { defaultKeyType, defaultStringType } = ctx.options;
      const t = implicitKey && defaultKeyType || defaultStringType;
      res = _stringify(t);
      if (res === null)
        throw new Error(`Unsupported default string type ${t}`);
    }
    return res;
  }
  exports.stringifyString = stringifyString;
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS((exports) => {
  var anchors = require_anchors();
  var identity = require_identity();
  var stringifyComment = require_stringifyComment();
  var stringifyString = require_stringifyString();
  function createStringifyContext(doc, options) {
    const opt = Object.assign({
      blockQuote: true,
      commentString: stringifyComment.stringifyComment,
      defaultKeyType: null,
      defaultStringType: "PLAIN",
      directives: null,
      doubleQuotedAsJSON: false,
      doubleQuotedMinMultiLineLength: 40,
      falseStr: "false",
      flowCollectionPadding: true,
      indentSeq: true,
      lineWidth: 80,
      minContentWidth: 20,
      nullStr: "null",
      simpleKeys: false,
      singleQuote: null,
      trailingComma: false,
      trueStr: "true",
      verifyAliasOrder: true
    }, doc.schema.toStringOptions, options);
    let inFlow;
    switch (opt.collectionStyle) {
      case "block":
        inFlow = false;
        break;
      case "flow":
        inFlow = true;
        break;
      default:
        inFlow = null;
    }
    return {
      anchors: new Set,
      doc,
      flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
      indent: "",
      indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
      inFlow,
      options: opt
    };
  }
  function getTagObject(tags, item) {
    if (item.tag) {
      const match = tags.filter((t) => t.tag === item.tag);
      if (match.length > 0)
        return match.find((t) => t.format === item.format) ?? match[0];
    }
    let tagObj = undefined;
    let obj;
    if (identity.isScalar(item)) {
      obj = item.value;
      let match = tags.filter((t) => t.identify?.(obj));
      if (match.length > 1) {
        const testMatch = match.filter((t) => t.test);
        if (testMatch.length > 0)
          match = testMatch;
      }
      tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
    } else {
      obj = item;
      tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
    }
    if (!tagObj) {
      const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
      throw new Error(`Tag not resolved for ${name} value`);
    }
    return tagObj;
  }
  function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
    if (!doc.directives)
      return "";
    const props = [];
    const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
    if (anchor && anchors.anchorIsValid(anchor)) {
      anchors$1.add(anchor);
      props.push(`&${anchor}`);
    }
    const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
    if (tag)
      props.push(doc.directives.tagString(tag));
    return props.join(" ");
  }
  function stringify(item, ctx, onComment, onChompKeep) {
    if (identity.isPair(item))
      return item.toString(ctx, onComment, onChompKeep);
    if (identity.isAlias(item)) {
      if (ctx.doc.directives)
        return item.toString(ctx);
      if (ctx.resolvedAliases?.has(item)) {
        throw new TypeError(`Cannot stringify circular structure without alias nodes`);
      } else {
        if (ctx.resolvedAliases)
          ctx.resolvedAliases.add(item);
        else
          ctx.resolvedAliases = new Set([item]);
        item = item.resolve(ctx.doc);
      }
    }
    let tagObj = undefined;
    const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
    tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
    const props = stringifyProps(node, tagObj, ctx);
    if (props.length > 0)
      ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
    const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
    if (!props)
      return str;
    return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
  }
  exports.createStringifyContext = createStringifyContext;
  exports.stringify = stringify;
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
    const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
    let keyComment = identity.isNode(key) && key.comment || null;
    if (simpleKeys) {
      if (keyComment) {
        throw new Error("With simple keys, key nodes cannot have comments");
      }
      if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
        const msg = "With simple keys, collection cannot be used as a key value";
        throw new Error(msg);
      }
    }
    let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
    ctx = Object.assign({}, ctx, {
      allNullValues: false,
      implicitKey: !explicitKey && (simpleKeys || !allNullValues),
      indent: indent + indentStep
    });
    let keyCommentDone = false;
    let chompKeep = false;
    let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
    if (!explicitKey && !ctx.inFlow && str.length > 1024) {
      if (simpleKeys)
        throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
      explicitKey = true;
    }
    if (ctx.inFlow) {
      if (allNullValues || value == null) {
        if (keyCommentDone && onComment)
          onComment();
        return str === "" ? "?" : explicitKey ? `? ${str}` : str;
      }
    } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
      str = `? ${str}`;
      if (keyComment && !keyCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    if (keyCommentDone)
      keyComment = null;
    if (explicitKey) {
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      str = `? ${str}
${indent}:`;
    } else {
      str = `${str}:`;
      if (keyComment)
        str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
    }
    let vsb, vcb, valueComment;
    if (identity.isNode(value)) {
      vsb = !!value.spaceBefore;
      vcb = value.commentBefore;
      valueComment = value.comment;
    } else {
      vsb = false;
      vcb = null;
      valueComment = null;
      if (value && typeof value === "object")
        value = doc.createNode(value);
    }
    ctx.implicitKey = false;
    if (!explicitKey && !keyComment && identity.isScalar(value))
      ctx.indentAtStart = str.length + 1;
    chompKeep = false;
    if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
      ctx.indent = ctx.indent.substring(2);
    }
    let valueCommentDone = false;
    const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
    let ws = " ";
    if (keyComment || vsb || vcb) {
      ws = vsb ? `
` : "";
      if (vcb) {
        const cs = commentString(vcb);
        ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
      }
      if (valueStr === "" && !ctx.inFlow) {
        if (ws === `
` && valueComment)
          ws = `

`;
      } else {
        ws += `
${ctx.indent}`;
      }
    } else if (!explicitKey && identity.isCollection(value)) {
      const vs0 = valueStr[0];
      const nl0 = valueStr.indexOf(`
`);
      const hasNewline = nl0 !== -1;
      const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
      if (hasNewline || !flow) {
        let hasPropsLine = false;
        if (hasNewline && (vs0 === "&" || vs0 === "!")) {
          let sp0 = valueStr.indexOf(" ");
          if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
            sp0 = valueStr.indexOf(" ", sp0 + 1);
          }
          if (sp0 === -1 || nl0 < sp0)
            hasPropsLine = true;
        }
        if (!hasPropsLine)
          ws = `
${ctx.indent}`;
      }
    } else if (valueStr === "" || valueStr[0] === `
`) {
      ws = "";
    }
    str += ws + valueStr;
    if (ctx.inFlow) {
      if (valueCommentDone && onComment)
        onComment();
    } else if (valueComment && !valueCommentDone) {
      str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
    } else if (chompKeep && onChompKeep) {
      onChompKeep();
    }
    return str;
  }
  exports.stringifyPair = stringifyPair;
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS((exports) => {
  var node_process = __require("process");
  function debug(logLevel, ...messages) {
    if (logLevel === "debug")
      console.log(...messages);
  }
  function warn(logLevel, warning) {
    if (logLevel === "debug" || logLevel === "warn") {
      if (typeof node_process.emitWarning === "function")
        node_process.emitWarning(warning);
      else
        console.warn(warning);
    }
  }
  exports.debug = debug;
  exports.warn = warn;
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var MERGE_KEY = "<<";
  var merge = {
    identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
    default: "key",
    tag: "tag:yaml.org,2002:merge",
    test: /^<<$/,
    resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
      addToJSMap: addMergeToJSMap
    }),
    stringify: () => MERGE_KEY
  };
  var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
  function addMergeToJSMap(ctx, map, value) {
    const source = resolveAliasValue(ctx, value);
    if (identity.isSeq(source))
      for (const it of source.items)
        mergeValue(ctx, map, it);
    else if (Array.isArray(source))
      for (const it of source)
        mergeValue(ctx, map, it);
    else
      mergeValue(ctx, map, source);
  }
  function mergeValue(ctx, map, value) {
    const source = resolveAliasValue(ctx, value);
    if (!identity.isMap(source))
      throw new Error("Merge sources must be maps or map aliases");
    const srcMap = source.toJSON(null, ctx, Map);
    for (const [key, value2] of srcMap) {
      if (map instanceof Map) {
        if (!map.has(key))
          map.set(key, value2);
      } else if (map instanceof Set) {
        map.add(key);
      } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
        Object.defineProperty(map, key, {
          value: value2,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }
    return map;
  }
  function resolveAliasValue(ctx, value) {
    return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
  }
  exports.addMergeToJSMap = addMergeToJSMap;
  exports.isMergeKey = isMergeKey;
  exports.merge = merge;
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS((exports) => {
  var log = require_log();
  var merge = require_merge();
  var stringify = require_stringify();
  var identity = require_identity();
  var toJS = require_toJS();
  function addPairToJSMap(ctx, map, { key, value }) {
    if (identity.isNode(key) && key.addToJSMap)
      key.addToJSMap(ctx, map, value);
    else if (merge.isMergeKey(ctx, key))
      merge.addMergeToJSMap(ctx, map, value);
    else {
      const jsKey = toJS.toJS(key, "", ctx);
      if (map instanceof Map) {
        map.set(jsKey, toJS.toJS(value, jsKey, ctx));
      } else if (map instanceof Set) {
        map.add(jsKey);
      } else {
        const stringKey = stringifyKey(key, jsKey, ctx);
        const jsValue = toJS.toJS(value, stringKey, ctx);
        if (stringKey in map)
          Object.defineProperty(map, stringKey, {
            value: jsValue,
            writable: true,
            enumerable: true,
            configurable: true
          });
        else
          map[stringKey] = jsValue;
      }
    }
    return map;
  }
  function stringifyKey(key, jsKey, ctx) {
    if (jsKey === null)
      return "";
    if (typeof jsKey !== "object")
      return String(jsKey);
    if (identity.isNode(key) && ctx?.doc) {
      const strCtx = stringify.createStringifyContext(ctx.doc, {});
      strCtx.anchors = new Set;
      for (const node of ctx.anchors.keys())
        strCtx.anchors.add(node.anchor);
      strCtx.inFlow = true;
      strCtx.inStringifyKey = true;
      const strKey = key.toString(strCtx);
      if (!ctx.mapKeyWarned) {
        let jsonStr = JSON.stringify(strKey);
        if (jsonStr.length > 40)
          jsonStr = jsonStr.substring(0, 36) + '..."';
        log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
        ctx.mapKeyWarned = true;
      }
      return strKey;
    }
    return JSON.stringify(jsKey);
  }
  exports.addPairToJSMap = addPairToJSMap;
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyPair = require_stringifyPair();
  var addPairToJSMap = require_addPairToJSMap();
  var identity = require_identity();
  function createPair(key, value, ctx) {
    const k = createNode.createNode(key, undefined, ctx);
    const v = createNode.createNode(value, undefined, ctx);
    return new Pair(k, v);
  }

  class Pair {
    constructor(key, value = null) {
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
      this.key = key;
      this.value = value;
    }
    clone(schema) {
      let { key, value } = this;
      if (identity.isNode(key))
        key = key.clone(schema);
      if (identity.isNode(value))
        value = value.clone(schema);
      return new Pair(key, value);
    }
    toJSON(_, ctx) {
      const pair = ctx?.mapAsMap ? new Map : {};
      return addPairToJSMap.addPairToJSMap(ctx, pair, this);
    }
    toString(ctx, onComment, onChompKeep) {
      return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
    }
  }
  exports.Pair = Pair;
  exports.createPair = createPair;
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyCollection(collection, ctx, options) {
    const flow = ctx.inFlow ?? collection.flow;
    const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
    return stringify2(collection, ctx, options);
  }
  function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
    const { indent, options: { commentString } } = ctx;
    const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
    let chompKeep = false;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment2 = null;
      if (identity.isNode(item)) {
        if (!chompKeep && item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
        if (item.comment)
          comment2 = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (!chompKeep && ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
        }
      }
      chompKeep = false;
      let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
      if (comment2)
        str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
      if (chompKeep && comment2)
        chompKeep = false;
      lines.push(blockItemPrefix + str2);
    }
    let str;
    if (lines.length === 0) {
      str = flowChars.start + flowChars.end;
    } else {
      str = lines[0];
      for (let i = 1;i < lines.length; ++i) {
        const line = lines[i];
        str += line ? `
${indent}${line}` : `
`;
      }
    }
    if (comment) {
      str += `
` + stringifyComment.indentComment(commentString(comment), indent);
      if (onComment)
        onComment();
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
    const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
    itemIndent += indentStep;
    const itemCtx = Object.assign({}, ctx, {
      indent: itemIndent,
      inFlow: true,
      type: null
    });
    let reqNewline = false;
    let linesAtValue = 0;
    const lines = [];
    for (let i = 0;i < items.length; ++i) {
      const item = items[i];
      let comment = null;
      if (identity.isNode(item)) {
        if (item.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, item.commentBefore, false);
        if (item.comment)
          comment = item.comment;
      } else if (identity.isPair(item)) {
        const ik = identity.isNode(item.key) ? item.key : null;
        if (ik) {
          if (ik.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, ik.commentBefore, false);
          if (ik.comment)
            reqNewline = true;
        }
        const iv = identity.isNode(item.value) ? item.value : null;
        if (iv) {
          if (iv.comment)
            comment = iv.comment;
          if (iv.commentBefore)
            reqNewline = true;
        } else if (item.value == null && ik?.comment) {
          comment = ik.comment;
        }
      }
      if (comment)
        reqNewline = true;
      let str = stringify.stringify(item, itemCtx, () => comment = null);
      reqNewline || (reqNewline = lines.length > linesAtValue || str.includes(`
`));
      if (i < items.length - 1) {
        str += ",";
      } else if (ctx.options.trailingComma) {
        if (ctx.options.lineWidth > 0) {
          reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
        }
        if (reqNewline) {
          str += ",";
        }
      }
      if (comment)
        str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
      lines.push(str);
      linesAtValue = lines.length;
    }
    const { start, end } = flowChars;
    if (lines.length === 0) {
      return start + end;
    } else {
      if (!reqNewline) {
        const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
        reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
      }
      if (reqNewline) {
        let str = start;
        for (const line of lines)
          str += line ? `
${indentStep}${indent}${line}` : `
`;
        return `${str}
${indent}${end}`;
      } else {
        return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
      }
    }
  }
  function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
    if (comment && chompKeep)
      comment = comment.replace(/^\n+/, "");
    if (comment) {
      const ic = stringifyComment.indentComment(commentString(comment), indent);
      lines.push(ic.trimStart());
    }
  }
  exports.stringifyCollection = stringifyCollection;
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS((exports) => {
  var stringifyCollection = require_stringifyCollection();
  var addPairToJSMap = require_addPairToJSMap();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  function findPair(items, key) {
    const k = identity.isScalar(key) ? key.value : key;
    for (const it of items) {
      if (identity.isPair(it)) {
        if (it.key === key || it.key === k)
          return it;
        if (identity.isScalar(it.key) && it.key.value === k)
          return it;
      }
    }
    return;
  }

  class YAMLMap extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:map";
    }
    constructor(schema) {
      super(identity.MAP, schema);
      this.items = [];
    }
    static from(schema, obj, ctx) {
      const { keepUndefined, replacer } = ctx;
      const map = new this(schema);
      const add = (key, value) => {
        if (typeof replacer === "function")
          value = replacer.call(obj, key, value);
        else if (Array.isArray(replacer) && !replacer.includes(key))
          return;
        if (value !== undefined || keepUndefined)
          map.items.push(Pair.createPair(key, value, ctx));
      };
      if (obj instanceof Map) {
        for (const [key, value] of obj)
          add(key, value);
      } else if (obj && typeof obj === "object") {
        for (const key of Object.keys(obj))
          add(key, obj[key]);
      }
      if (typeof schema.sortMapEntries === "function") {
        map.items.sort(schema.sortMapEntries);
      }
      return map;
    }
    add(pair, overwrite) {
      let _pair;
      if (identity.isPair(pair))
        _pair = pair;
      else if (!pair || typeof pair !== "object" || !("key" in pair)) {
        _pair = new Pair.Pair(pair, pair?.value);
      } else
        _pair = new Pair.Pair(pair.key, pair.value);
      const prev = findPair(this.items, _pair.key);
      const sortEntries = this.schema?.sortMapEntries;
      if (prev) {
        if (!overwrite)
          throw new Error(`Key ${_pair.key} already set`);
        if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
          prev.value.value = _pair.value;
        else
          prev.value = _pair.value;
      } else if (sortEntries) {
        const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
        if (i === -1)
          this.items.push(_pair);
        else
          this.items.splice(i, 0, _pair);
      } else {
        this.items.push(_pair);
      }
    }
    delete(key) {
      const it = findPair(this.items, key);
      if (!it)
        return false;
      const del = this.items.splice(this.items.indexOf(it), 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const it = findPair(this.items, key);
      const node = it?.value;
      return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? undefined;
    }
    has(key) {
      return !!findPair(this.items, key);
    }
    set(key, value) {
      this.add(new Pair.Pair(key, value), true);
    }
    toJSON(_, ctx, Type) {
      const map = Type ? new Type : ctx?.mapAsMap ? new Map : {};
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const item of this.items)
        addPairToJSMap.addPairToJSMap(ctx, map, item);
      return map;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      for (const item of this.items) {
        if (!identity.isPair(item))
          throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
      }
      if (!ctx.allNullValues && this.hasAllNullValues(false))
        ctx = Object.assign({}, ctx, { allNullValues: true });
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "",
        flowChars: { start: "{", end: "}" },
        itemIndent: ctx.indent || "",
        onChompKeep,
        onComment
      });
    }
  }
  exports.YAMLMap = YAMLMap;
  exports.findPair = findPair;
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLMap = require_YAMLMap();
  var map = {
    collection: "map",
    default: true,
    nodeClass: YAMLMap.YAMLMap,
    tag: "tag:yaml.org,2002:map",
    resolve(map2, onError) {
      if (!identity.isMap(map2))
        onError("Expected a mapping for this tag");
      return map2;
    },
    createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
  };
  exports.map = map;
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS((exports) => {
  var createNode = require_createNode();
  var stringifyCollection = require_stringifyCollection();
  var Collection = require_Collection();
  var identity = require_identity();
  var Scalar = require_Scalar();
  var toJS = require_toJS();

  class YAMLSeq extends Collection.Collection {
    static get tagName() {
      return "tag:yaml.org,2002:seq";
    }
    constructor(schema) {
      super(identity.SEQ, schema);
      this.items = [];
    }
    add(value) {
      this.items.push(value);
    }
    delete(key) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return false;
      const del = this.items.splice(idx, 1);
      return del.length > 0;
    }
    get(key, keepScalar) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        return;
      const it = this.items[idx];
      return !keepScalar && identity.isScalar(it) ? it.value : it;
    }
    has(key) {
      const idx = asItemIndex(key);
      return typeof idx === "number" && idx < this.items.length;
    }
    set(key, value) {
      const idx = asItemIndex(key);
      if (typeof idx !== "number")
        throw new Error(`Expected a valid index, not ${key}.`);
      const prev = this.items[idx];
      if (identity.isScalar(prev) && Scalar.isScalarValue(value))
        prev.value = value;
      else
        this.items[idx] = value;
    }
    toJSON(_, ctx) {
      const seq = [];
      if (ctx?.onCreate)
        ctx.onCreate(seq);
      let i = 0;
      for (const item of this.items)
        seq.push(toJS.toJS(item, String(i++), ctx));
      return seq;
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      return stringifyCollection.stringifyCollection(this, ctx, {
        blockItemPrefix: "- ",
        flowChars: { start: "[", end: "]" },
        itemIndent: (ctx.indent || "") + "  ",
        onChompKeep,
        onComment
      });
    }
    static from(schema, obj, ctx) {
      const { replacer } = ctx;
      const seq = new this(schema);
      if (obj && Symbol.iterator in Object(obj)) {
        let i = 0;
        for (let it of obj) {
          if (typeof replacer === "function") {
            const key = obj instanceof Set ? it : String(i++);
            it = replacer.call(obj, key, it);
          }
          seq.items.push(createNode.createNode(it, undefined, ctx));
        }
      }
      return seq;
    }
  }
  function asItemIndex(key) {
    let idx = identity.isScalar(key) ? key.value : key;
    if (idx && typeof idx === "string")
      idx = Number(idx);
    return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
  }
  exports.YAMLSeq = YAMLSeq;
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS((exports) => {
  var identity = require_identity();
  var YAMLSeq = require_YAMLSeq();
  var seq = {
    collection: "seq",
    default: true,
    nodeClass: YAMLSeq.YAMLSeq,
    tag: "tag:yaml.org,2002:seq",
    resolve(seq2, onError) {
      if (!identity.isSeq(seq2))
        onError("Expected a sequence for this tag");
      return seq2;
    },
    createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
  };
  exports.seq = seq;
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS((exports) => {
  var stringifyString = require_stringifyString();
  var string = {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify(item, ctx, onComment, onChompKeep) {
      ctx = Object.assign({ actualString: true }, ctx);
      return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
    }
  };
  exports.string = string;
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var nullTag = {
    identify: (value) => value == null,
    createNode: () => new Scalar.Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar.Scalar(null),
    stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
  };
  exports.nullTag = nullTag;
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var boolTag = {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
    resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
    stringify({ source, value }, ctx) {
      if (source && boolTag.test.test(source)) {
        const sv = source[0] === "t" || source[0] === "T";
        if (value === sv)
          return source;
      }
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
  };
  exports.boolTag = boolTag;
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS((exports) => {
  function stringifyNumber({ format, minFractionDigits, tag, value }) {
    if (typeof value === "bigint")
      return String(value);
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num))
      return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
    let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
    if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
      let i = n.indexOf(".");
      if (i < 0) {
        i = n.length;
        n += ".";
      }
      let d = minFractionDigits - (n.length - i - 1);
      while (d-- > 0)
        n += "0";
    }
    return n;
  }
  exports.stringifyNumber = stringifyNumber;
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str));
      const dot = str.indexOf(".");
      if (dot !== -1 && str[str.length - 1] === "0")
        node.minFractionDigits = str.length - dot - 1;
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value) && value >= 0)
      return prefix + value.toString(radix);
    return stringifyNumber.stringifyNumber(node);
  }
  var intOct = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^0o[0-7]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
    stringify: (node) => intStringify(node, 8, "0o")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: (value) => intIdentify(value) && value >= 0,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^0x[0-9a-fA-F]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.boolTag,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float
  ];
  exports.schema = schema;
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var map = require_map();
  var seq = require_seq();
  function intIdentify(value) {
    return typeof value === "bigint" || Number.isInteger(value);
  }
  var stringifyJSON = ({ value }) => JSON.stringify(value);
  var jsonScalars = [
    {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify: stringifyJSON
    },
    {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^null$/,
      resolve: () => null,
      stringify: stringifyJSON
    },
    {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^true$|^false$/,
      resolve: (str) => str === "true",
      stringify: stringifyJSON
    },
    {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^-?(?:0|[1-9][0-9]*)$/,
      resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
      stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
    },
    {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
      resolve: (str) => parseFloat(str),
      stringify: stringifyJSON
    }
  ];
  var jsonError = {
    default: true,
    tag: "",
    test: /^/,
    resolve(str, onError) {
      onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
      return str;
    }
  };
  var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
  exports.schema = schema;
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS((exports) => {
  var node_buffer = __require("buffer");
  var Scalar = require_Scalar();
  var stringifyString = require_stringifyString();
  var binary = {
    identify: (value) => value instanceof Uint8Array,
    default: false,
    tag: "tag:yaml.org,2002:binary",
    resolve(src, onError) {
      if (typeof node_buffer.Buffer === "function") {
        return node_buffer.Buffer.from(src, "base64");
      } else if (typeof atob === "function") {
        const str = atob(src.replace(/[\n\r]/g, ""));
        const buffer = new Uint8Array(str.length);
        for (let i = 0;i < str.length; ++i)
          buffer[i] = str.charCodeAt(i);
        return buffer;
      } else {
        onError("This environment does not support reading binary tags; either Buffer or atob is required");
        return src;
      }
    },
    stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
      if (!value)
        return "";
      const buf = value;
      let str;
      if (typeof node_buffer.Buffer === "function") {
        str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
      } else if (typeof btoa === "function") {
        let s = "";
        for (let i = 0;i < buf.length; ++i)
          s += String.fromCharCode(buf[i]);
        str = btoa(s);
      } else {
        throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
      }
      type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
        const n = Math.ceil(str.length / lineWidth);
        const lines = new Array(n);
        for (let i = 0, o = 0;i < n; ++i, o += lineWidth) {
          lines[i] = str.substr(o, lineWidth);
        }
        str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? `
` : " ");
      }
      return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
    }
  };
  exports.binary = binary;
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var Scalar = require_Scalar();
  var YAMLSeq = require_YAMLSeq();
  function resolvePairs(seq, onError) {
    if (identity.isSeq(seq)) {
      for (let i = 0;i < seq.items.length; ++i) {
        let item = seq.items[i];
        if (identity.isPair(item))
          continue;
        else if (identity.isMap(item)) {
          if (item.items.length > 1)
            onError("Each pair must have its own sequence indicator");
          const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
          if (item.commentBefore)
            pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
          if (item.comment) {
            const cn = pair.value ?? pair.key;
            cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
          }
          item = pair;
        }
        seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
      }
    } else
      onError("Expected a sequence for this tag");
    return seq;
  }
  function createPairs(schema, iterable, ctx) {
    const { replacer } = ctx;
    const pairs2 = new YAMLSeq.YAMLSeq(schema);
    pairs2.tag = "tag:yaml.org,2002:pairs";
    let i = 0;
    if (iterable && Symbol.iterator in Object(iterable))
      for (let it of iterable) {
        if (typeof replacer === "function")
          it = replacer.call(iterable, String(i++), it);
        let key, value;
        if (Array.isArray(it)) {
          if (it.length === 2) {
            key = it[0];
            value = it[1];
          } else
            throw new TypeError(`Expected [key, value] tuple: ${it}`);
        } else if (it && it instanceof Object) {
          const keys = Object.keys(it);
          if (keys.length === 1) {
            key = keys[0];
            value = it[key];
          } else {
            throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
          }
        } else {
          key = it;
        }
        pairs2.items.push(Pair.createPair(key, value, ctx));
      }
    return pairs2;
  }
  var pairs = {
    collection: "seq",
    default: false,
    tag: "tag:yaml.org,2002:pairs",
    resolve: resolvePairs,
    createNode: createPairs
  };
  exports.createPairs = createPairs;
  exports.pairs = pairs;
  exports.resolvePairs = resolvePairs;
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS((exports) => {
  var identity = require_identity();
  var toJS = require_toJS();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var pairs = require_pairs();

  class YAMLOMap extends YAMLSeq.YAMLSeq {
    constructor() {
      super();
      this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
      this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
      this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
      this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
      this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
      this.tag = YAMLOMap.tag;
    }
    toJSON(_, ctx) {
      if (!ctx)
        return super.toJSON(_);
      const map = new Map;
      if (ctx?.onCreate)
        ctx.onCreate(map);
      for (const pair of this.items) {
        let key, value;
        if (identity.isPair(pair)) {
          key = toJS.toJS(pair.key, "", ctx);
          value = toJS.toJS(pair.value, key, ctx);
        } else {
          key = toJS.toJS(pair, "", ctx);
        }
        if (map.has(key))
          throw new Error("Ordered maps must not include duplicate keys");
        map.set(key, value);
      }
      return map;
    }
    static from(schema, iterable, ctx) {
      const pairs$1 = pairs.createPairs(schema, iterable, ctx);
      const omap2 = new this;
      omap2.items = pairs$1.items;
      return omap2;
    }
  }
  YAMLOMap.tag = "tag:yaml.org,2002:omap";
  var omap = {
    collection: "seq",
    identify: (value) => value instanceof Map,
    nodeClass: YAMLOMap,
    default: false,
    tag: "tag:yaml.org,2002:omap",
    resolve(seq, onError) {
      const pairs$1 = pairs.resolvePairs(seq, onError);
      const seenKeys = [];
      for (const { key } of pairs$1.items) {
        if (identity.isScalar(key)) {
          if (seenKeys.includes(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${key.value}`);
          } else {
            seenKeys.push(key.value);
          }
        }
      }
      return Object.assign(new YAMLOMap, pairs$1);
    },
    createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
  };
  exports.YAMLOMap = YAMLOMap;
  exports.omap = omap;
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function boolStringify({ value, source }, ctx) {
    const boolObj = value ? trueTag : falseTag;
    if (source && boolObj.test.test(source))
      return source;
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
  var trueTag = {
    identify: (value) => value === true,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
    resolve: () => new Scalar.Scalar(true),
    stringify: boolStringify
  };
  var falseTag = {
    identify: (value) => value === false,
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
    resolve: () => new Scalar.Scalar(false),
    stringify: boolStringify
  };
  exports.falseTag = falseTag;
  exports.trueTag = trueTag;
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var stringifyNumber = require_stringifyNumber();
  var floatNaN = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
    resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
    stringify: stringifyNumber.stringifyNumber
  };
  var floatExp = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "EXP",
    test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
    resolve: (str) => parseFloat(str.replace(/_/g, "")),
    stringify(node) {
      const num = Number(node.value);
      return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
    }
  };
  var float = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
    resolve(str) {
      const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
      const dot = str.indexOf(".");
      if (dot !== -1) {
        const f = str.substring(dot + 1).replace(/_/g, "");
        if (f[f.length - 1] === "0")
          node.minFractionDigits = f.length;
      }
      return node;
    },
    stringify: stringifyNumber.stringifyNumber
  };
  exports.float = float;
  exports.floatExp = floatExp;
  exports.floatNaN = floatNaN;
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
  function intResolve(str, offset, radix, { intAsBigInt }) {
    const sign = str[0];
    if (sign === "-" || sign === "+")
      offset += 1;
    str = str.substring(offset).replace(/_/g, "");
    if (intAsBigInt) {
      switch (radix) {
        case 2:
          str = `0b${str}`;
          break;
        case 8:
          str = `0o${str}`;
          break;
        case 16:
          str = `0x${str}`;
          break;
      }
      const n2 = BigInt(str);
      return sign === "-" ? BigInt(-1) * n2 : n2;
    }
    const n = parseInt(str, radix);
    return sign === "-" ? -1 * n : n;
  }
  function intStringify(node, radix, prefix) {
    const { value } = node;
    if (intIdentify(value)) {
      const str = value.toString(radix);
      return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
    }
    return stringifyNumber.stringifyNumber(node);
  }
  var intBin = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "BIN",
    test: /^[-+]?0b[0-1_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
    stringify: (node) => intStringify(node, 2, "0b")
  };
  var intOct = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "OCT",
    test: /^[-+]?0[0-7_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
    stringify: (node) => intStringify(node, 8, "0")
  };
  var int = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^[-+]?[0-9][0-9_]*$/,
    resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
    stringify: stringifyNumber.stringifyNumber
  };
  var intHex = {
    identify: intIdentify,
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "HEX",
    test: /^[-+]?0x[0-9a-fA-F_]+$/,
    resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
    stringify: (node) => intStringify(node, 16, "0x")
  };
  exports.int = int;
  exports.intBin = intBin;
  exports.intHex = intHex;
  exports.intOct = intOct;
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();

  class YAMLSet extends YAMLMap.YAMLMap {
    constructor(schema) {
      super(schema);
      this.tag = YAMLSet.tag;
    }
    add(key) {
      let pair;
      if (identity.isPair(key))
        pair = key;
      else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
        pair = new Pair.Pair(key.key, null);
      else
        pair = new Pair.Pair(key, null);
      const prev = YAMLMap.findPair(this.items, pair.key);
      if (!prev)
        this.items.push(pair);
    }
    get(key, keepPair) {
      const pair = YAMLMap.findPair(this.items, key);
      return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
    }
    set(key, value) {
      if (typeof value !== "boolean")
        throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
      const prev = YAMLMap.findPair(this.items, key);
      if (prev && !value) {
        this.items.splice(this.items.indexOf(prev), 1);
      } else if (!prev && value) {
        this.items.push(new Pair.Pair(key));
      }
    }
    toJSON(_, ctx) {
      return super.toJSON(_, ctx, Set);
    }
    toString(ctx, onComment, onChompKeep) {
      if (!ctx)
        return JSON.stringify(this);
      if (this.hasAllNullValues(true))
        return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
      else
        throw new Error("Set items must all have null values");
    }
    static from(schema, iterable, ctx) {
      const { replacer } = ctx;
      const set2 = new this(schema);
      if (iterable && Symbol.iterator in Object(iterable))
        for (let value of iterable) {
          if (typeof replacer === "function")
            value = replacer.call(iterable, value, value);
          set2.items.push(Pair.createPair(value, null, ctx));
        }
      return set2;
    }
  }
  YAMLSet.tag = "tag:yaml.org,2002:set";
  var set = {
    collection: "map",
    identify: (value) => value instanceof Set,
    nodeClass: YAMLSet,
    default: false,
    tag: "tag:yaml.org,2002:set",
    createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
    resolve(map, onError) {
      if (identity.isMap(map)) {
        if (map.hasAllNullValues(true))
          return Object.assign(new YAMLSet, map);
        else
          onError("Set items must all have null values");
      } else
        onError("Expected a mapping for this tag");
      return map;
    }
  };
  exports.YAMLSet = YAMLSet;
  exports.set = set;
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS((exports) => {
  var stringifyNumber = require_stringifyNumber();
  function parseSexagesimal(str, asBigInt) {
    const sign = str[0];
    const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
    const num = (n) => asBigInt ? BigInt(n) : Number(n);
    const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
    return sign === "-" ? num(-1) * res : res;
  }
  function stringifySexagesimal(node) {
    let { value } = node;
    let num = (n) => n;
    if (typeof value === "bigint")
      num = (n) => BigInt(n);
    else if (isNaN(value) || !isFinite(value))
      return stringifyNumber.stringifyNumber(node);
    let sign = "";
    if (value < 0) {
      sign = "-";
      value *= num(-1);
    }
    const _60 = num(60);
    const parts = [value % _60];
    if (value < 60) {
      parts.unshift(0);
    } else {
      value = (value - parts[0]) / _60;
      parts.unshift(value % _60);
      if (value >= 60) {
        value = (value - parts[0]) / _60;
        parts.unshift(value);
      }
    }
    return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
  }
  var intTime = {
    identify: (value) => typeof value === "bigint" || Number.isInteger(value),
    default: true,
    tag: "tag:yaml.org,2002:int",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
    resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
    stringify: stringifySexagesimal
  };
  var floatTime = {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    format: "TIME",
    test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
    resolve: (str) => parseSexagesimal(str, false),
    stringify: stringifySexagesimal
  };
  var timestamp = {
    identify: (value) => value instanceof Date,
    default: true,
    tag: "tag:yaml.org,2002:timestamp",
    test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})" + "(?:" + "(?:t|T|[ \\t]+)" + "([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)" + "(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?" + ")?$"),
    resolve(str) {
      const match = str.match(timestamp.test);
      if (!match)
        throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
      const [, year, month, day, hour, minute, second] = match.map(Number);
      const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
      let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
      const tz = match[8];
      if (tz && tz !== "Z") {
        let d = parseSexagesimal(tz, false);
        if (Math.abs(d) < 30)
          d *= 60;
        date -= 60000 * d;
      }
      return new Date(date);
    },
    stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
  };
  exports.floatTime = floatTime;
  exports.intTime = intTime;
  exports.timestamp = timestamp;
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var binary = require_binary();
  var bool = require_bool2();
  var float = require_float2();
  var int = require_int2();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var set = require_set();
  var timestamp = require_timestamp();
  var schema = [
    map.map,
    seq.seq,
    string.string,
    _null.nullTag,
    bool.trueTag,
    bool.falseTag,
    int.intBin,
    int.intOct,
    int.int,
    int.intHex,
    float.floatNaN,
    float.floatExp,
    float.float,
    binary.binary,
    merge.merge,
    omap.omap,
    pairs.pairs,
    set.set,
    timestamp.intTime,
    timestamp.floatTime,
    timestamp.timestamp
  ];
  exports.schema = schema;
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS((exports) => {
  var map = require_map();
  var _null = require_null();
  var seq = require_seq();
  var string = require_string();
  var bool = require_bool();
  var float = require_float();
  var int = require_int();
  var schema = require_schema();
  var schema$1 = require_schema2();
  var binary = require_binary();
  var merge = require_merge();
  var omap = require_omap();
  var pairs = require_pairs();
  var schema$2 = require_schema3();
  var set = require_set();
  var timestamp = require_timestamp();
  var schemas = new Map([
    ["core", schema.schema],
    ["failsafe", [map.map, seq.seq, string.string]],
    ["json", schema$1.schema],
    ["yaml11", schema$2.schema],
    ["yaml-1.1", schema$2.schema]
  ]);
  var tagsByName = {
    binary: binary.binary,
    bool: bool.boolTag,
    float: float.float,
    floatExp: float.floatExp,
    floatNaN: float.floatNaN,
    floatTime: timestamp.floatTime,
    int: int.int,
    intHex: int.intHex,
    intOct: int.intOct,
    intTime: timestamp.intTime,
    map: map.map,
    merge: merge.merge,
    null: _null.nullTag,
    omap: omap.omap,
    pairs: pairs.pairs,
    seq: seq.seq,
    set: set.set,
    timestamp: timestamp.timestamp
  };
  var coreKnownTags = {
    "tag:yaml.org,2002:binary": binary.binary,
    "tag:yaml.org,2002:merge": merge.merge,
    "tag:yaml.org,2002:omap": omap.omap,
    "tag:yaml.org,2002:pairs": pairs.pairs,
    "tag:yaml.org,2002:set": set.set,
    "tag:yaml.org,2002:timestamp": timestamp.timestamp
  };
  function getTags(customTags, schemaName, addMergeTag) {
    const schemaTags = schemas.get(schemaName);
    if (schemaTags && !customTags) {
      return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
    }
    let tags = schemaTags;
    if (!tags) {
      if (Array.isArray(customTags))
        tags = [];
      else {
        const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
      }
    }
    if (Array.isArray(customTags)) {
      for (const tag of customTags)
        tags = tags.concat(tag);
    } else if (typeof customTags === "function") {
      tags = customTags(tags.slice());
    }
    if (addMergeTag)
      tags = tags.concat(merge.merge);
    return tags.reduce((tags2, tag) => {
      const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
      if (!tagObj) {
        const tagName = JSON.stringify(tag);
        const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
        throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
      }
      if (!tags2.includes(tagObj))
        tags2.push(tagObj);
      return tags2;
    }, []);
  }
  exports.coreKnownTags = coreKnownTags;
  exports.getTags = getTags;
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS((exports) => {
  var identity = require_identity();
  var map = require_map();
  var seq = require_seq();
  var string = require_string();
  var tags = require_tags();
  var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

  class Schema {
    constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
      this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
      this.name = typeof schema === "string" && schema || "core";
      this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
      this.tags = tags.getTags(customTags, this.name, merge);
      this.toStringOptions = toStringDefaults ?? null;
      Object.defineProperty(this, identity.MAP, { value: map.map });
      Object.defineProperty(this, identity.SCALAR, { value: string.string });
      Object.defineProperty(this, identity.SEQ, { value: seq.seq });
      this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
    }
    clone() {
      const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
      copy.tags = this.tags.slice();
      return copy;
    }
  }
  exports.Schema = Schema;
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS((exports) => {
  var identity = require_identity();
  var stringify = require_stringify();
  var stringifyComment = require_stringifyComment();
  function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false && doc.directives) {
      const dir = doc.directives.toString(doc);
      if (dir) {
        lines.push(dir);
        hasDirectives = true;
      } else if (doc.directives.docStart)
        hasDirectives = true;
    }
    if (hasDirectives)
      lines.push("---");
    const ctx = stringify.createStringifyContext(doc, options);
    const { commentString } = ctx.options;
    if (doc.commentBefore) {
      if (lines.length !== 1)
        lines.unshift("");
      const cs = commentString(doc.commentBefore);
      lines.unshift(stringifyComment.indentComment(cs, ""));
    }
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
      if (identity.isNode(doc.contents)) {
        if (doc.contents.spaceBefore && hasDirectives)
          lines.push("");
        if (doc.contents.commentBefore) {
          const cs = commentString(doc.contents.commentBefore);
          lines.push(stringifyComment.indentComment(cs, ""));
        }
        ctx.forceBlockIndent = !!doc.comment;
        contentComment = doc.contents.comment;
      }
      const onChompKeep = contentComment ? undefined : () => chompKeep = true;
      let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
      if (contentComment)
        body += stringifyComment.lineComment(body, "", commentString(contentComment));
      if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
        lines[lines.length - 1] = `--- ${body}`;
      } else
        lines.push(body);
    } else {
      lines.push(stringify.stringify(doc.contents, ctx));
    }
    if (doc.directives?.docEnd) {
      if (doc.comment) {
        const cs = commentString(doc.comment);
        if (cs.includes(`
`)) {
          lines.push("...");
          lines.push(stringifyComment.indentComment(cs, ""));
        } else {
          lines.push(`... ${cs}`);
        }
      } else {
        lines.push("...");
      }
    } else {
      let dc = doc.comment;
      if (dc && chompKeep)
        dc = dc.replace(/^\n+/, "");
      if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
          lines.push("");
        lines.push(stringifyComment.indentComment(commentString(dc), ""));
      }
    }
    return lines.join(`
`) + `
`;
  }
  exports.stringifyDocument = stringifyDocument;
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS((exports) => {
  var Alias = require_Alias();
  var Collection = require_Collection();
  var identity = require_identity();
  var Pair = require_Pair();
  var toJS = require_toJS();
  var Schema = require_Schema();
  var stringifyDocument = require_stringifyDocument();
  var anchors = require_anchors();
  var applyReviver = require_applyReviver();
  var createNode = require_createNode();
  var directives = require_directives();

  class Document {
    constructor(value, replacer, options) {
      this.commentBefore = null;
      this.comment = null;
      this.errors = [];
      this.warnings = [];
      Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const opt = Object.assign({
        intAsBigInt: false,
        keepSourceTokens: false,
        logLevel: "warn",
        prettyErrors: true,
        strict: true,
        stringKeys: false,
        uniqueKeys: true,
        version: "1.2"
      }, options);
      this.options = opt;
      let { version } = opt;
      if (options?._directives) {
        this.directives = options._directives.atDocument();
        if (this.directives.yaml.explicit)
          version = this.directives.yaml.version;
      } else
        this.directives = new directives.Directives({ version });
      this.setSchema(version, options);
      this.contents = value === undefined ? null : this.createNode(value, _replacer, options);
    }
    clone() {
      const copy = Object.create(Document.prototype, {
        [identity.NODE_TYPE]: { value: identity.DOC }
      });
      copy.commentBefore = this.commentBefore;
      copy.comment = this.comment;
      copy.errors = this.errors.slice();
      copy.warnings = this.warnings.slice();
      copy.options = Object.assign({}, this.options);
      if (this.directives)
        copy.directives = this.directives.clone();
      copy.schema = this.schema.clone();
      copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
      if (this.range)
        copy.range = this.range.slice();
      return copy;
    }
    add(value) {
      if (assertCollection(this.contents))
        this.contents.add(value);
    }
    addIn(path, value) {
      if (assertCollection(this.contents))
        this.contents.addIn(path, value);
    }
    createAlias(node, name) {
      if (!node.anchor) {
        const prev = anchors.anchorNames(this);
        node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
      }
      return new Alias.Alias(node.anchor);
    }
    createNode(value, replacer, options) {
      let _replacer = undefined;
      if (typeof replacer === "function") {
        value = replacer.call({ "": value }, "", value);
        _replacer = replacer;
      } else if (Array.isArray(replacer)) {
        const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
        const asStr = replacer.filter(keyToStr).map(String);
        if (asStr.length > 0)
          replacer = replacer.concat(asStr);
        _replacer = replacer;
      } else if (options === undefined && replacer) {
        options = replacer;
        replacer = undefined;
      }
      const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
      const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
      const ctx = {
        aliasDuplicateObjects: aliasDuplicateObjects ?? true,
        keepUndefined: keepUndefined ?? false,
        onAnchor,
        onTagObj,
        replacer: _replacer,
        schema: this.schema,
        sourceObjects
      };
      const node = createNode.createNode(value, tag, ctx);
      if (flow && identity.isCollection(node))
        node.flow = true;
      setAnchors();
      return node;
    }
    createPair(key, value, options = {}) {
      const k = this.createNode(key, null, options);
      const v = this.createNode(value, null, options);
      return new Pair.Pair(k, v);
    }
    delete(key) {
      return assertCollection(this.contents) ? this.contents.delete(key) : false;
    }
    deleteIn(path) {
      if (Collection.isEmptyPath(path)) {
        if (this.contents == null)
          return false;
        this.contents = null;
        return true;
      }
      return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
    }
    get(key, keepScalar) {
      return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : undefined;
    }
    getIn(path, keepScalar) {
      if (Collection.isEmptyPath(path))
        return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
      return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : undefined;
    }
    has(key) {
      return identity.isCollection(this.contents) ? this.contents.has(key) : false;
    }
    hasIn(path) {
      if (Collection.isEmptyPath(path))
        return this.contents !== undefined;
      return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
    }
    set(key, value) {
      if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, [key], value);
      } else if (assertCollection(this.contents)) {
        this.contents.set(key, value);
      }
    }
    setIn(path, value) {
      if (Collection.isEmptyPath(path)) {
        this.contents = value;
      } else if (this.contents == null) {
        this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
      } else if (assertCollection(this.contents)) {
        this.contents.setIn(path, value);
      }
    }
    setSchema(version, options = {}) {
      if (typeof version === "number")
        version = String(version);
      let opt;
      switch (version) {
        case "1.1":
          if (this.directives)
            this.directives.yaml.version = "1.1";
          else
            this.directives = new directives.Directives({ version: "1.1" });
          opt = { resolveKnownTags: false, schema: "yaml-1.1" };
          break;
        case "1.2":
        case "next":
          if (this.directives)
            this.directives.yaml.version = version;
          else
            this.directives = new directives.Directives({ version });
          opt = { resolveKnownTags: true, schema: "core" };
          break;
        case null:
          if (this.directives)
            delete this.directives;
          opt = null;
          break;
        default: {
          const sv = JSON.stringify(version);
          throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
        }
      }
      if (options.schema instanceof Object)
        this.schema = options.schema;
      else if (opt)
        this.schema = new Schema.Schema(Object.assign(opt, options));
      else
        throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
    }
    toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
      const ctx = {
        anchors: new Map,
        doc: this,
        keep: !json,
        mapAsMap: mapAsMap === true,
        mapKeyWarned: false,
        maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
      };
      const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
      if (typeof onAnchor === "function")
        for (const { count, res: res2 } of ctx.anchors.values())
          onAnchor(res2, count);
      return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
    }
    toJSON(jsonArg, onAnchor) {
      return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
    }
    toString(options = {}) {
      if (this.errors.length > 0)
        throw new Error("Document with errors cannot be stringified");
      if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
        const s = JSON.stringify(options.indent);
        throw new Error(`"indent" option must be a positive integer, not ${s}`);
      }
      return stringifyDocument.stringifyDocument(this, options);
    }
  }
  function assertCollection(contents) {
    if (identity.isCollection(contents))
      return true;
    throw new Error("Expected a YAML collection as document contents");
  }
  exports.Document = Document;
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS((exports) => {
  class YAMLError extends Error {
    constructor(name, pos, code, message) {
      super();
      this.name = name;
      this.code = code;
      this.message = message;
      this.pos = pos;
    }
  }

  class YAMLParseError extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLParseError", pos, code, message);
    }
  }

  class YAMLWarning extends YAMLError {
    constructor(pos, code, message) {
      super("YAMLWarning", pos, code, message);
    }
  }
  var prettifyError = (src, lc) => (error) => {
    if (error.pos[0] === -1)
      return;
    error.linePos = error.pos.map((pos) => lc.linePos(pos));
    const { line, col } = error.linePos[0];
    error.message += ` at line ${line}, column ${col}`;
    let ci = col - 1;
    let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
    if (ci >= 60 && lineStr.length > 80) {
      const trimStart = Math.min(ci - 39, lineStr.length - 79);
      lineStr = "…" + lineStr.substring(trimStart);
      ci -= trimStart - 1;
    }
    if (lineStr.length > 80)
      lineStr = lineStr.substring(0, 79) + "…";
    if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
      let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
      if (prev.length > 80)
        prev = prev.substring(0, 79) + `…
`;
      lineStr = prev + lineStr;
    }
    if (/[^ ]/.test(lineStr)) {
      let count = 1;
      const end = error.linePos[1];
      if (end?.line === line && end.col > col) {
        count = Math.max(1, Math.min(end.col - col, 80 - ci));
      }
      const pointer = " ".repeat(ci) + "^".repeat(count);
      error.message += `:

${lineStr}
${pointer}
`;
    }
  };
  exports.YAMLError = YAMLError;
  exports.YAMLParseError = YAMLParseError;
  exports.YAMLWarning = YAMLWarning;
  exports.prettifyError = prettifyError;
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS((exports) => {
  function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
    let spaceBefore = false;
    let atNewline = startOnNewline;
    let hasSpace = startOnNewline;
    let comment = "";
    let commentSep = "";
    let hasNewline = false;
    let reqSpace = false;
    let tab = null;
    let anchor = null;
    let tag = null;
    let newlineAfterProp = null;
    let comma = null;
    let found = null;
    let start = null;
    for (const token of tokens) {
      if (reqSpace) {
        if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
          onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
        reqSpace = false;
      }
      if (tab) {
        if (atNewline && token.type !== "comment" && token.type !== "newline") {
          onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
        }
        tab = null;
      }
      switch (token.type) {
        case "space":
          if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("\t")) {
            tab = token;
          }
          hasSpace = true;
          break;
        case "comment": {
          if (!hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = token.source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += commentSep + cb;
          commentSep = "";
          atNewline = false;
          break;
        }
        case "newline":
          if (atNewline) {
            if (comment)
              comment += token.source;
            else if (!found || indicator !== "seq-item-ind")
              spaceBefore = true;
          } else
            commentSep += token.source;
          atNewline = true;
          hasNewline = true;
          if (anchor || tag)
            newlineAfterProp = token;
          hasSpace = true;
          break;
        case "anchor":
          if (anchor)
            onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
          if (token.source.endsWith(":"))
            onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
          anchor = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        case "tag": {
          if (tag)
            onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
          tag = token;
          start ?? (start = token.offset);
          atNewline = false;
          hasSpace = false;
          reqSpace = true;
          break;
        }
        case indicator:
          if (anchor || tag)
            onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
          if (found)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
          found = token;
          atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
          hasSpace = false;
          break;
        case "comma":
          if (flow) {
            if (comma)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
            comma = token;
            atNewline = false;
            hasSpace = false;
            break;
          }
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
          atNewline = false;
          hasSpace = false;
      }
    }
    const last = tokens[tokens.length - 1];
    const end = last ? last.offset + last.source.length : offset;
    if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
      onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
    }
    if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
      onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
    return {
      comma,
      found,
      spaceBefore,
      comment,
      hasNewline,
      anchor,
      tag,
      newlineAfterProp,
      end,
      start: start ?? end
    };
  }
  exports.resolveProps = resolveProps;
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS((exports) => {
  function containsNewline(key) {
    if (!key)
      return null;
    switch (key.type) {
      case "alias":
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        if (key.source.includes(`
`))
          return true;
        if (key.end) {
          for (const st of key.end)
            if (st.type === "newline")
              return true;
        }
        return false;
      case "flow-collection":
        for (const it of key.items) {
          for (const st of it.start)
            if (st.type === "newline")
              return true;
          if (it.sep) {
            for (const st of it.sep)
              if (st.type === "newline")
                return true;
          }
          if (containsNewline(it.key) || containsNewline(it.value))
            return true;
        }
        return false;
      default:
        return true;
    }
  }
  exports.containsNewline = containsNewline;
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS((exports) => {
  var utilContainsNewline = require_util_contains_newline();
  function flowIndentCheck(indent, fc, onError) {
    if (fc?.type === "flow-collection") {
      const end = fc.end[0];
      if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
        const msg = "Flow end indicator should be more indented than parent";
        onError(end, "BAD_INDENT", msg, true);
      }
    }
  }
  exports.flowIndentCheck = flowIndentCheck;
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS((exports) => {
  var identity = require_identity();
  function mapIncludes(ctx, items, search) {
    const { uniqueKeys } = ctx.options;
    if (uniqueKeys === false)
      return false;
    const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
    return items.some((pair) => isEqual(pair.key, search));
  }
  exports.mapIncludes = mapIncludes;
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS((exports) => {
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  var utilMapIncludes = require_util_map_includes();
  var startColMsg = "All mapping items must start at the same column";
  function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
    const map = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    let offset = bm.offset;
    let commentEnd = null;
    for (const collItem of bm.items) {
      const { start, key, sep: sep3, value } = collItem;
      const keyProps = resolveProps.resolveProps(start, {
        indicator: "explicit-key-ind",
        next: key ?? sep3?.[0],
        offset,
        onError,
        parentIndent: bm.indent,
        startOnNewline: true
      });
      const implicitKey = !keyProps.found;
      if (implicitKey) {
        if (key) {
          if (key.type === "block-seq")
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
          else if ("indent" in key && key.indent !== bm.indent)
            onError(offset, "BAD_INDENT", startColMsg);
        }
        if (!keyProps.anchor && !keyProps.tag && !sep3) {
          commentEnd = keyProps.end;
          if (keyProps.comment) {
            if (map.comment)
              map.comment += `
` + keyProps.comment;
            else
              map.comment = keyProps.comment;
          }
          continue;
        }
        if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
          onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
        }
      } else if (keyProps.found?.indent !== bm.indent) {
        onError(offset, "BAD_INDENT", startColMsg);
      }
      ctx.atKey = true;
      const keyStart = keyProps.end;
      const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
      ctx.atKey = false;
      if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
        onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
      const valueProps = resolveProps.resolveProps(sep3 ?? [], {
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: bm.indent,
        startOnNewline: !key || key.type === "block-scalar"
      });
      offset = valueProps.end;
      if (valueProps.found) {
        if (implicitKey) {
          if (value?.type === "block-map" && !valueProps.hasNewline)
            onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
          if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
            onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep3, null, valueProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
        offset = valueNode.range[2];
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      } else {
        if (implicitKey)
          onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
        if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        map.items.push(pair);
      }
    }
    if (commentEnd && commentEnd < offset)
      onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
    map.range = [bm.offset, offset, commentEnd ?? offset];
    return map;
  }
  exports.resolveBlockMap = resolveBlockMap;
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS((exports) => {
  var YAMLSeq = require_YAMLSeq();
  var resolveProps = require_resolve_props();
  var utilFlowIndentCheck = require_util_flow_indent_check();
  function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
    const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
    const seq = new NodeClass(ctx.schema);
    if (ctx.atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = bs.offset;
    let commentEnd = null;
    for (const { start, value } of bs.items) {
      const props = resolveProps.resolveProps(start, {
        indicator: "seq-item-ind",
        next: value,
        offset,
        onError,
        parentIndent: bs.indent,
        startOnNewline: true
      });
      if (!props.found) {
        if (props.anchor || props.tag || value) {
          if (value?.type === "block-seq")
            onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
          else
            onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
        } else {
          commentEnd = props.end;
          if (props.comment)
            seq.comment = props.comment;
          continue;
        }
      }
      const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
      if (ctx.schema.compat)
        utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
      offset = node.range[2];
      seq.items.push(node);
    }
    seq.range = [bs.offset, offset, commentEnd ?? offset];
    return seq;
  }
  exports.resolveBlockSeq = resolveBlockSeq;
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS((exports) => {
  function resolveEnd(end, offset, reqSpace, onError) {
    let comment = "";
    if (end) {
      let hasSpace = false;
      let sep3 = "";
      for (const token of end) {
        const { source, type } = token;
        switch (type) {
          case "space":
            hasSpace = true;
            break;
          case "comment": {
            if (reqSpace && !hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += sep3 + cb;
            sep3 = "";
            break;
          }
          case "newline":
            if (comment)
              sep3 += source;
            hasSpace = true;
            break;
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
        }
        offset += source.length;
      }
    }
    return { comment, offset };
  }
  exports.resolveEnd = resolveEnd;
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Pair = require_Pair();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  var utilContainsNewline = require_util_contains_newline();
  var utilMapIncludes = require_util_map_includes();
  var blockMsg = "Block collections are not allowed within flow collections";
  var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
  function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
    const isMap = fc.start.source === "{";
    const fcName = isMap ? "flow map" : "flow sequence";
    const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
    const coll = new NodeClass(ctx.schema);
    coll.flow = true;
    const atRoot = ctx.atRoot;
    if (atRoot)
      ctx.atRoot = false;
    if (ctx.atKey)
      ctx.atKey = false;
    let offset = fc.offset + fc.start.source.length;
    for (let i = 0;i < fc.items.length; ++i) {
      const collItem = fc.items[i];
      const { start, key, sep: sep3, value } = collItem;
      const props = resolveProps.resolveProps(start, {
        flow: fcName,
        indicator: "explicit-key-ind",
        next: key ?? sep3?.[0],
        offset,
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (!props.found) {
        if (!props.anchor && !props.tag && !sep3 && !value) {
          if (i === 0 && props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
          else if (i < fc.items.length - 1)
            onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
          if (props.comment) {
            if (coll.comment)
              coll.comment += `
` + props.comment;
            else
              coll.comment = props.comment;
          }
          offset = props.end;
          continue;
        }
        if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
          onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
      }
      if (i === 0) {
        if (props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
      } else {
        if (!props.comma)
          onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
        if (props.comment) {
          let prevItemComment = "";
          loop:
            for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
          if (prevItemComment) {
            let prev = coll.items[coll.items.length - 1];
            if (identity.isPair(prev))
              prev = prev.value ?? prev.key;
            if (prev.comment)
              prev.comment += `
` + prevItemComment;
            else
              prev.comment = prevItemComment;
            props.comment = props.comment.substring(prevItemComment.length + 1);
          }
        }
      }
      if (!isMap && !sep3 && !props.found) {
        const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep3, null, props, onError);
        coll.items.push(valueNode);
        offset = valueNode.range[2];
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else {
        ctx.atKey = true;
        const keyStart = props.end;
        const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
        if (isBlock(key))
          onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
        ctx.atKey = false;
        const valueProps = resolveProps.resolveProps(sep3 ?? [], {
          flow: fcName,
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (valueProps.found) {
          if (!isMap && !props.found && ctx.options.strict) {
            if (sep3)
              for (const st of sep3) {
                if (st === valueProps.found)
                  break;
                if (st.type === "newline") {
                  onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                  break;
                }
              }
            if (props.start < valueProps.found.offset - 1024)
              onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
          }
        } else if (value) {
          if ("source" in value && value.source?.[0] === ":")
            onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
          else
            onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
        }
        const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep3, null, valueProps, onError) : null;
        if (valueNode) {
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else if (valueProps.comment) {
          if (keyNode.comment)
            keyNode.comment += `
` + valueProps.comment;
          else
            keyNode.comment = valueProps.comment;
        }
        const pair = new Pair.Pair(keyNode, valueNode);
        if (ctx.options.keepSourceTokens)
          pair.srcToken = collItem;
        if (isMap) {
          const map = coll;
          if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
            onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
          map.items.push(pair);
        } else {
          const map = new YAMLMap.YAMLMap(ctx.schema);
          map.flow = true;
          map.items.push(pair);
          const endRange = (valueNode ?? keyNode).range;
          map.range = [keyNode.range[0], endRange[1], endRange[2]];
          coll.items.push(map);
        }
        offset = valueNode ? valueNode.range[2] : valueProps.end;
      }
    }
    const expectedEnd = isMap ? "}" : "]";
    const [ce, ...ee] = fc.end;
    let cePos = offset;
    if (ce?.source === expectedEnd)
      cePos = ce.offset + ce.source.length;
    else {
      const name = fcName[0].toUpperCase() + fcName.substring(1);
      const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
      onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
      if (ce && ce.source.length !== 1)
        ee.unshift(ce);
    }
    if (ee.length > 0) {
      const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
      if (end.comment) {
        if (coll.comment)
          coll.comment += `
` + end.comment;
        else
          coll.comment = end.comment;
      }
      coll.range = [fc.offset, cePos, end.offset];
    } else {
      coll.range = [fc.offset, cePos, cePos];
    }
    return coll;
  }
  exports.resolveFlowCollection = resolveFlowCollection;
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var YAMLMap = require_YAMLMap();
  var YAMLSeq = require_YAMLSeq();
  var resolveBlockMap = require_resolve_block_map();
  var resolveBlockSeq = require_resolve_block_seq();
  var resolveFlowCollection = require_resolve_flow_collection();
  function resolveCollection(CN, ctx, token, onError, tagName, tag) {
    const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
    const Coll = coll.constructor;
    if (tagName === "!" || tagName === Coll.tagName) {
      coll.tag = Coll.tagName;
      return coll;
    }
    if (tagName)
      coll.tag = tagName;
    return coll;
  }
  function composeCollection(CN, ctx, token, props, onError) {
    const tagToken = props.tag;
    const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
    if (token.type === "block-seq") {
      const { anchor, newlineAfterProp: nl } = props;
      const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
      if (lastProp && (!nl || nl.offset < lastProp.offset)) {
        const message = "Missing newline after block sequence props";
        onError(lastProp, "MISSING_CHAR", message);
      }
    }
    const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
    if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
      return resolveCollection(CN, ctx, token, onError, tagName);
    }
    let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
    if (!tag) {
      const kt = ctx.schema.knownTags[tagName];
      if (kt?.collection === expType) {
        ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
        tag = kt;
      } else {
        if (kt) {
          onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
        } else {
          onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
        }
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
    }
    const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
    const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
    const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
    node.range = coll.range;
    node.tag = tagName;
    if (tag?.format)
      node.format = tag.format;
    return node;
  }
  exports.composeCollection = composeCollection;
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  function resolveBlockScalar(ctx, scalar, onError) {
    const start = scalar.offset;
    const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
    if (!header)
      return { value: "", type: null, comment: "", range: [start, start, start] };
    const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
    const lines = scalar.source ? splitLines(scalar.source) : [];
    let chompStart = lines.length;
    for (let i = lines.length - 1;i >= 0; --i) {
      const content = lines[i][1];
      if (content === "" || content === "\r")
        chompStart = i;
      else
        break;
    }
    if (chompStart === 0) {
      const value2 = header.chomp === "+" && lines.length > 0 ? `
`.repeat(Math.max(1, lines.length - 1)) : "";
      let end2 = start + header.length;
      if (scalar.source)
        end2 += scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
    }
    let trimIndent = scalar.indent + header.indent;
    let offset = scalar.offset + header.length;
    let contentStart = 0;
    for (let i = 0;i < chompStart; ++i) {
      const [indent, content] = lines[i];
      if (content === "" || content === "\r") {
        if (header.indent === 0 && indent.length > trimIndent)
          trimIndent = indent.length;
      } else {
        if (indent.length < trimIndent) {
          const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
          onError(offset + indent.length, "MISSING_CHAR", message);
        }
        if (header.indent === 0)
          trimIndent = indent.length;
        contentStart = i;
        if (trimIndent === 0 && !ctx.atRoot) {
          const message = "Block scalar values in collections must be indented";
          onError(offset, "BAD_INDENT", message);
        }
        break;
      }
      offset += indent.length + content.length + 1;
    }
    for (let i = lines.length - 1;i >= chompStart; --i) {
      if (lines[i][0].length > trimIndent)
        chompStart = i + 1;
    }
    let value = "";
    let sep3 = "";
    let prevMoreIndented = false;
    for (let i = 0;i < contentStart; ++i)
      value += lines[i][0].slice(trimIndent) + `
`;
    for (let i = contentStart;i < chompStart; ++i) {
      let [indent, content] = lines[i];
      offset += indent.length + content.length + 1;
      const crlf = content[content.length - 1] === "\r";
      if (crlf)
        content = content.slice(0, -1);
      if (content && indent.length < trimIndent) {
        const src = header.indent ? "explicit indentation indicator" : "first line";
        const message = `Block scalar lines must not be less indented than their ${src}`;
        onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
        indent = "";
      }
      if (type === Scalar.Scalar.BLOCK_LITERAL) {
        value += sep3 + indent.slice(trimIndent) + content;
        sep3 = `
`;
      } else if (indent.length > trimIndent || content[0] === "\t") {
        if (sep3 === " ")
          sep3 = `
`;
        else if (!prevMoreIndented && sep3 === `
`)
          sep3 = `

`;
        value += sep3 + indent.slice(trimIndent) + content;
        sep3 = `
`;
        prevMoreIndented = true;
      } else if (content === "") {
        if (sep3 === `
`)
          value += `
`;
        else
          sep3 = `
`;
      } else {
        value += sep3 + content;
        sep3 = " ";
        prevMoreIndented = false;
      }
    }
    switch (header.chomp) {
      case "-":
        break;
      case "+":
        for (let i = chompStart;i < lines.length; ++i)
          value += `
` + lines[i][0].slice(trimIndent);
        if (value[value.length - 1] !== `
`)
          value += `
`;
        break;
      default:
        value += `
`;
    }
    const end = start + header.length + scalar.source.length;
    return { value, type, comment: header.comment, range: [start, end, end] };
  }
  function parseBlockScalarHeader({ offset, props }, strict, onError) {
    if (props[0].type !== "block-scalar-header") {
      onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
      return null;
    }
    const { source } = props[0];
    const mode = source[0];
    let indent = 0;
    let chomp = "";
    let error = -1;
    for (let i = 1;i < source.length; ++i) {
      const ch = source[i];
      if (!chomp && (ch === "-" || ch === "+"))
        chomp = ch;
      else {
        const n = Number(ch);
        if (!indent && n)
          indent = n;
        else if (error === -1)
          error = offset + i;
      }
    }
    if (error !== -1)
      onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
    let hasSpace = false;
    let comment = "";
    let length = source.length;
    for (let i = 1;i < props.length; ++i) {
      const token = props[i];
      switch (token.type) {
        case "space":
          hasSpace = true;
        case "newline":
          length += token.source.length;
          break;
        case "comment":
          if (strict && !hasSpace) {
            const message = "Comments must be separated from other tokens by white space characters";
            onError(token, "MISSING_CHAR", message);
          }
          length += token.source.length;
          comment = token.source.substring(1);
          break;
        case "error":
          onError(token, "UNEXPECTED_TOKEN", token.message);
          length += token.source.length;
          break;
        default: {
          const message = `Unexpected token in block scalar header: ${token.type}`;
          onError(token, "UNEXPECTED_TOKEN", message);
          const ts = token.source;
          if (ts && typeof ts === "string")
            length += ts.length;
        }
      }
    }
    return { mode, indent, chomp, comment, length };
  }
  function splitLines(source) {
    const split = source.split(/\n( *)/);
    const first = split[0];
    const m = first.match(/^( *)/);
    const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
    const lines = [line0];
    for (let i = 1;i < split.length; i += 2)
      lines.push([split[i], split[i + 1]]);
    return lines;
  }
  exports.resolveBlockScalar = resolveBlockScalar;
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS((exports) => {
  var Scalar = require_Scalar();
  var resolveEnd = require_resolve_end();
  function resolveFlowScalar(scalar, strict, onError) {
    const { offset, type, source, end } = scalar;
    let _type;
    let value;
    const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
    switch (type) {
      case "scalar":
        _type = Scalar.Scalar.PLAIN;
        value = plainValue(source, _onError);
        break;
      case "single-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_SINGLE;
        value = singleQuotedValue(source, _onError);
        break;
      case "double-quoted-scalar":
        _type = Scalar.Scalar.QUOTE_DOUBLE;
        value = doubleQuotedValue(source, _onError);
        break;
      default:
        onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
        return {
          value: "",
          type: null,
          comment: "",
          range: [offset, offset + source.length, offset + source.length]
        };
    }
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
    return {
      value,
      type: _type,
      comment: re.comment,
      range: [offset, valueEnd, re.offset]
    };
  }
  function plainValue(source, onError) {
    let badChar = "";
    switch (source[0]) {
      case "\t":
        badChar = "a tab character";
        break;
      case ",":
        badChar = "flow indicator character ,";
        break;
      case "%":
        badChar = "directive indicator character %";
        break;
      case "|":
      case ">": {
        badChar = `block scalar indicator ${source[0]}`;
        break;
      }
      case "@":
      case "`": {
        badChar = `reserved character ${source[0]}`;
        break;
      }
    }
    if (badChar)
      onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
    return foldLines(source);
  }
  function singleQuotedValue(source, onError) {
    if (source[source.length - 1] !== "'" || source.length === 1)
      onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
    return foldLines(source.slice(1, -1)).replace(/''/g, "'");
  }
  function foldLines(source) {
    let first, line;
    try {
      first = new RegExp(`(.*?)(?<![ 	])[ 	]*\r?
`, "sy");
      line = new RegExp(`[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?
`, "sy");
    } catch {
      first = /(.*?)[ \t]*\r?\n/sy;
      line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
    }
    let match = first.exec(source);
    if (!match)
      return source;
    let res = match[1];
    let sep3 = " ";
    let pos = first.lastIndex;
    line.lastIndex = pos;
    while (match = line.exec(source)) {
      if (match[1] === "") {
        if (sep3 === `
`)
          res += sep3;
        else
          sep3 = `
`;
      } else {
        res += sep3 + match[1];
        sep3 = " ";
      }
      pos = line.lastIndex;
    }
    const last = /[ \t]*(.*)/sy;
    last.lastIndex = pos;
    match = last.exec(source);
    return res + sep3 + (match?.[1] ?? "");
  }
  function doubleQuotedValue(source, onError) {
    let res = "";
    for (let i = 1;i < source.length - 1; ++i) {
      const ch = source[i];
      if (ch === "\r" && source[i + 1] === `
`)
        continue;
      if (ch === `
`) {
        const { fold, offset } = foldNewline(source, i);
        res += fold;
        i = offset;
      } else if (ch === "\\") {
        let next = source[++i];
        const cc = escapeCodes[next];
        if (cc)
          res += cc;
        else if (next === `
`) {
          next = source[i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "\r" && source[i + 1] === `
`) {
          next = source[++i + 1];
          while (next === " " || next === "\t")
            next = source[++i + 1];
        } else if (next === "x" || next === "u" || next === "U") {
          const length = next === "x" ? 2 : next === "u" ? 4 : 8;
          res += parseCharCode(source, i + 1, length, onError);
          i += length;
        } else {
          const raw = source.substr(i - 1, 2);
          onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
          res += raw;
        }
      } else if (ch === " " || ch === "\t") {
        const wsStart = i;
        let next = source[i + 1];
        while (next === " " || next === "\t")
          next = source[++i + 1];
        if (next !== `
` && !(next === "\r" && source[i + 2] === `
`))
          res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
      } else {
        res += ch;
      }
    }
    if (source[source.length - 1] !== '"' || source.length === 1)
      onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
    return res;
  }
  function foldNewline(source, offset) {
    let fold = "";
    let ch = source[offset + 1];
    while (ch === " " || ch === "\t" || ch === `
` || ch === "\r") {
      if (ch === "\r" && source[offset + 2] !== `
`)
        break;
      if (ch === `
`)
        fold += `
`;
      offset += 1;
      ch = source[offset + 1];
    }
    if (!fold)
      fold = " ";
    return { fold, offset };
  }
  var escapeCodes = {
    "0": "\x00",
    a: "\x07",
    b: "\b",
    e: "\x1B",
    f: "\f",
    n: `
`,
    r: "\r",
    t: "\t",
    v: "\v",
    N: "",
    _: " ",
    L: "\u2028",
    P: "\u2029",
    " ": " ",
    '"': '"',
    "/": "/",
    "\\": "\\",
    "\t": "\t"
  };
  function parseCharCode(source, offset, length, onError) {
    const cc = source.substr(offset, length);
    const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
    const code = ok ? parseInt(cc, 16) : NaN;
    try {
      return String.fromCodePoint(code);
    } catch {
      const raw = source.substr(offset - 2, length + 2);
      onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
      return raw;
    }
  }
  exports.resolveFlowScalar = resolveFlowScalar;
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS((exports) => {
  var identity = require_identity();
  var Scalar = require_Scalar();
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  function composeScalar(ctx, token, tagToken, onError) {
    const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
    const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
    let tag;
    if (ctx.options.stringKeys && ctx.atKey) {
      tag = ctx.schema[identity.SCALAR];
    } else if (tagName)
      tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
    else if (token.type === "scalar")
      tag = findScalarTagByTest(ctx, value, token, onError);
    else
      tag = ctx.schema[identity.SCALAR];
    let scalar;
    try {
      const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
      scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
      scalar = new Scalar.Scalar(value);
    }
    scalar.range = range;
    scalar.source = value;
    if (type)
      scalar.type = type;
    if (tagName)
      scalar.tag = tagName;
    if (tag.format)
      scalar.format = tag.format;
    if (comment)
      scalar.comment = comment;
    return scalar;
  }
  function findScalarTagByName(schema, value, tagName, tagToken, onError) {
    if (tagName === "!")
      return schema[identity.SCALAR];
    const matchWithTest = [];
    for (const tag of schema.tags) {
      if (!tag.collection && tag.tag === tagName) {
        if (tag.default && tag.test)
          matchWithTest.push(tag);
        else
          return tag;
      }
    }
    for (const tag of matchWithTest)
      if (tag.test?.test(value))
        return tag;
    const kt = schema.knownTags[tagName];
    if (kt && !kt.collection) {
      schema.tags.push(Object.assign({}, kt, { default: false, test: undefined }));
      return kt;
    }
    onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
    return schema[identity.SCALAR];
  }
  function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
    const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
    if (schema.compat) {
      const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
      if (tag.tag !== compat.tag) {
        const ts = directives.tagString(tag.tag);
        const cs = directives.tagString(compat.tag);
        const msg = `Value may be parsed as either ${ts} or ${cs}`;
        onError(token, "TAG_RESOLVE_FAILED", msg, true);
      }
    }
    return tag;
  }
  exports.composeScalar = composeScalar;
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS((exports) => {
  function emptyScalarPosition(offset, before, pos) {
    if (before) {
      pos ?? (pos = before.length);
      for (let i = pos - 1;i >= 0; --i) {
        let st = before[i];
        switch (st.type) {
          case "space":
          case "comment":
          case "newline":
            offset -= st.source.length;
            continue;
        }
        st = before[++i];
        while (st?.type === "space") {
          offset += st.source.length;
          st = before[++i];
        }
        break;
      }
    }
    return offset;
  }
  exports.emptyScalarPosition = emptyScalarPosition;
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS((exports) => {
  var Alias = require_Alias();
  var identity = require_identity();
  var composeCollection = require_compose_collection();
  var composeScalar = require_compose_scalar();
  var resolveEnd = require_resolve_end();
  var utilEmptyScalarPosition = require_util_empty_scalar_position();
  var CN = { composeNode, composeEmptyNode };
  function composeNode(ctx, token, props, onError) {
    const atKey = ctx.atKey;
    const { spaceBefore, comment, anchor, tag } = props;
    let node;
    let isSrcToken = true;
    switch (token.type) {
      case "alias":
        node = composeAlias(ctx, token, onError);
        if (anchor || tag)
          onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
        break;
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar":
        node = composeScalar.composeScalar(ctx, token, tag, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
        break;
      case "block-map":
      case "block-seq":
      case "flow-collection":
        try {
          node = composeCollection.composeCollection(CN, ctx, token, props, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onError(token, "RESOURCE_EXHAUSTION", message);
        }
        break;
      default: {
        const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
        onError(token, "UNEXPECTED_TOKEN", message);
        isSrcToken = false;
      }
    }
    node ?? (node = composeEmptyNode(ctx, token.offset, undefined, null, props, onError));
    if (anchor && node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
      const msg = "With stringKeys, all keys must be strings";
      onError(tag ?? token, "NON_STRING_KEY", msg);
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      if (token.type === "scalar" && token.source === "")
        node.comment = comment;
      else
        node.commentBefore = comment;
    }
    if (ctx.options.keepSourceTokens && isSrcToken)
      node.srcToken = token;
    return node;
  }
  function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
    const token = {
      type: "scalar",
      offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
      indent: -1,
      source: ""
    };
    const node = composeScalar.composeScalar(ctx, token, tag, onError);
    if (anchor) {
      node.anchor = anchor.source.substring(1);
      if (node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
    }
    if (spaceBefore)
      node.spaceBefore = true;
    if (comment) {
      node.comment = comment;
      node.range[2] = end;
    }
    return node;
  }
  function composeAlias({ options }, { offset, source, end }, onError) {
    const alias = new Alias.Alias(source.substring(1));
    if (alias.source === "")
      onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
    if (alias.source.endsWith(":"))
      onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
    const valueEnd = offset + source.length;
    const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
    alias.range = [offset, valueEnd, re.offset];
    if (re.comment)
      alias.comment = re.comment;
    return alias;
  }
  exports.composeEmptyNode = composeEmptyNode;
  exports.composeNode = composeNode;
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS((exports) => {
  var Document = require_Document();
  var composeNode = require_compose_node();
  var resolveEnd = require_resolve_end();
  var resolveProps = require_resolve_props();
  function composeDoc(options, directives, { offset, start, value, end }, onError) {
    const opts = Object.assign({ _directives: directives }, options);
    const doc = new Document.Document(undefined, opts);
    const ctx = {
      atKey: false,
      atRoot: true,
      directives: doc.directives,
      options: doc.options,
      schema: doc.schema
    };
    const props = resolveProps.resolveProps(start, {
      indicator: "doc-start",
      next: value ?? end?.[0],
      offset,
      onError,
      parentIndent: 0,
      startOnNewline: true
    });
    if (props.found) {
      doc.directives.docStart = true;
      if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
        onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
    }
    doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
    const contentEnd = doc.contents.range[2];
    const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
    if (re.comment)
      doc.comment = re.comment;
    doc.range = [offset, contentEnd, re.offset];
    return doc;
  }
  exports.composeDoc = composeDoc;
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS((exports) => {
  var node_process = __require("process");
  var directives = require_directives();
  var Document = require_Document();
  var errors = require_errors();
  var identity = require_identity();
  var composeDoc = require_compose_doc();
  var resolveEnd = require_resolve_end();
  function getErrorPos(src) {
    if (typeof src === "number")
      return [src, src + 1];
    if (Array.isArray(src))
      return src.length === 2 ? src : [src[0], src[1]];
    const { offset, source } = src;
    return [offset, offset + (typeof source === "string" ? source.length : 1)];
  }
  function parsePrelude(prelude) {
    let comment = "";
    let atComment = false;
    let afterEmptyLine = false;
    for (let i = 0;i < prelude.length; ++i) {
      const source = prelude[i];
      switch (source[0]) {
        case "#":
          comment += (comment === "" ? "" : afterEmptyLine ? `

` : `
`) + (source.substring(1) || " ");
          atComment = true;
          afterEmptyLine = false;
          break;
        case "%":
          if (prelude[i + 1]?.[0] !== "#")
            i += 1;
          atComment = false;
          break;
        default:
          if (!atComment)
            afterEmptyLine = true;
          atComment = false;
      }
    }
    return { comment, afterEmptyLine };
  }

  class Composer {
    constructor(options = {}) {
      this.doc = null;
      this.atDirectives = false;
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
      this.onError = (source, code, message, warning) => {
        const pos = getErrorPos(source);
        if (warning)
          this.warnings.push(new errors.YAMLWarning(pos, code, message));
        else
          this.errors.push(new errors.YAMLParseError(pos, code, message));
      };
      this.directives = new directives.Directives({ version: options.version || "1.2" });
      this.options = options;
    }
    decorate(doc, afterDoc) {
      const { comment, afterEmptyLine } = parsePrelude(this.prelude);
      if (comment) {
        const dc = doc.contents;
        if (afterDoc) {
          doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
        } else if (afterEmptyLine || doc.directives.docStart || !dc) {
          doc.commentBefore = comment;
        } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
          let it = dc.items[0];
          if (identity.isPair(it))
            it = it.key;
          const cb = it.commentBefore;
          it.commentBefore = cb ? `${comment}
${cb}` : comment;
        } else {
          const cb = dc.commentBefore;
          dc.commentBefore = cb ? `${comment}
${cb}` : comment;
        }
      }
      if (afterDoc) {
        for (let i = 0;i < this.errors.length; ++i)
          doc.errors.push(this.errors[i]);
        for (let i = 0;i < this.warnings.length; ++i)
          doc.warnings.push(this.warnings[i]);
      } else {
        doc.errors = this.errors;
        doc.warnings = this.warnings;
      }
      this.prelude = [];
      this.errors = [];
      this.warnings = [];
    }
    streamInfo() {
      return {
        comment: parsePrelude(this.prelude).comment,
        directives: this.directives,
        errors: this.errors,
        warnings: this.warnings
      };
    }
    *compose(tokens, forceDoc = false, endOffset = -1) {
      for (const token of tokens)
        yield* this.next(token);
      yield* this.end(forceDoc, endOffset);
    }
    *next(token) {
      if (node_process.env.LOG_STREAM)
        console.dir(token, { depth: null });
      switch (token.type) {
        case "directive":
          this.directives.add(token.source, (offset, message, warning) => {
            const pos = getErrorPos(token);
            pos[0] += offset;
            this.onError(pos, "BAD_DIRECTIVE", message, warning);
          });
          this.prelude.push(token.source);
          this.atDirectives = true;
          break;
        case "document": {
          const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
          if (this.atDirectives && !doc.directives.docStart)
            this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
          this.decorate(doc, false);
          if (this.doc)
            yield this.doc;
          this.doc = doc;
          this.atDirectives = false;
          break;
        }
        case "byte-order-mark":
        case "space":
          break;
        case "comment":
        case "newline":
          this.prelude.push(token.source);
          break;
        case "error": {
          const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
          const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
          if (this.atDirectives || !this.doc)
            this.errors.push(error);
          else
            this.doc.errors.push(error);
          break;
        }
        case "doc-end": {
          if (!this.doc) {
            const msg = "Unexpected doc-end without preceding document";
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
            break;
          }
          this.doc.directives.docEnd = true;
          const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
          this.decorate(this.doc, true);
          if (end.comment) {
            const dc = this.doc.comment;
            this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
          }
          this.doc.range[2] = end.offset;
          break;
        }
        default:
          this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
      }
    }
    *end(forceDoc = false, endOffset = -1) {
      if (this.doc) {
        this.decorate(this.doc, true);
        yield this.doc;
        this.doc = null;
      } else if (forceDoc) {
        const opts = Object.assign({ _directives: this.directives }, this.options);
        const doc = new Document.Document(undefined, opts);
        if (this.atDirectives)
          this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
        doc.range = [0, endOffset, endOffset];
        this.decorate(doc, false);
        yield doc;
      }
    }
  }
  exports.Composer = Composer;
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS((exports) => {
  var resolveBlockScalar = require_resolve_block_scalar();
  var resolveFlowScalar = require_resolve_flow_scalar();
  var errors = require_errors();
  var stringifyString = require_stringifyString();
  function resolveAsScalar(token, strict = true, onError) {
    if (token) {
      const _onError = (pos, code, message) => {
        const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
        if (onError)
          onError(offset, code, message);
        else
          throw new errors.YAMLParseError([offset, offset + 1], code, message);
      };
      switch (token.type) {
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
        case "block-scalar":
          return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
      }
    }
    return null;
  }
  function createScalarToken(value, context) {
    const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey,
      indent: indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    const end = context.end ?? [
      { type: "newline", offset: -1, indent, source: `
` }
    ];
    switch (source[0]) {
      case "|":
      case ">": {
        const he = source.indexOf(`
`);
        const head = source.substring(0, he);
        const body = source.substring(he + 1) + `
`;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, end))
          props.push({ type: "newline", offset: -1, indent, source: `
` });
        return { type: "block-scalar", offset, indent, props, source: body };
      }
      case '"':
        return { type: "double-quoted-scalar", offset, indent, source, end };
      case "'":
        return { type: "single-quoted-scalar", offset, indent, source, end };
      default:
        return { type: "scalar", offset, indent, source, end };
    }
  }
  function setScalarValue(token, value, context = {}) {
    let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
    let indent = "indent" in token ? token.indent : null;
    if (afterKey && typeof indent === "number")
      indent += 2;
    if (!type)
      switch (token.type) {
        case "single-quoted-scalar":
          type = "QUOTE_SINGLE";
          break;
        case "double-quoted-scalar":
          type = "QUOTE_DOUBLE";
          break;
        case "block-scalar": {
          const header = token.props[0];
          if (header.type !== "block-scalar-header")
            throw new Error("Invalid block scalar header");
          type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
          break;
        }
        default:
          type = "PLAIN";
      }
    const source = stringifyString.stringifyString({ type, value }, {
      implicitKey: implicitKey || indent === null,
      indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
      inFlow,
      options: { blockQuote: true, lineWidth: -1 }
    });
    switch (source[0]) {
      case "|":
      case ">":
        setBlockScalarValue(token, source);
        break;
      case '"':
        setFlowScalarValue(token, source, "double-quoted-scalar");
        break;
      case "'":
        setFlowScalarValue(token, source, "single-quoted-scalar");
        break;
      default:
        setFlowScalarValue(token, source, "scalar");
    }
  }
  function setBlockScalarValue(token, source) {
    const he = source.indexOf(`
`);
    const head = source.substring(0, he);
    const body = source.substring(he + 1) + `
`;
    if (token.type === "block-scalar") {
      const header = token.props[0];
      if (header.type !== "block-scalar-header")
        throw new Error("Invalid block scalar header");
      header.source = head;
      token.source = body;
    } else {
      const { offset } = token;
      const indent = "indent" in token ? token.indent : -1;
      const props = [
        { type: "block-scalar-header", offset, indent, source: head }
      ];
      if (!addEndtoBlockProps(props, "end" in token ? token.end : undefined))
        props.push({ type: "newline", offset: -1, indent, source: `
` });
      for (const key of Object.keys(token))
        if (key !== "type" && key !== "offset")
          delete token[key];
      Object.assign(token, { type: "block-scalar", indent, props, source: body });
    }
  }
  function addEndtoBlockProps(props, end) {
    if (end)
      for (const st of end)
        switch (st.type) {
          case "space":
          case "comment":
            props.push(st);
            break;
          case "newline":
            props.push(st);
            return true;
        }
    return false;
  }
  function setFlowScalarValue(token, source, type) {
    switch (token.type) {
      case "scalar":
      case "double-quoted-scalar":
      case "single-quoted-scalar":
        token.type = type;
        token.source = source;
        break;
      case "block-scalar": {
        const end = token.props.slice(1);
        let oa = source.length;
        if (token.props[0].type === "block-scalar-header")
          oa -= token.props[0].source.length;
        for (const tok of end)
          tok.offset += oa;
        delete token.props;
        Object.assign(token, { type, source, end });
        break;
      }
      case "block-map":
      case "block-seq": {
        const offset = token.offset + source.length;
        const nl = { type: "newline", offset, indent: token.indent, source: `
` };
        delete token.items;
        Object.assign(token, { type, source, end: [nl] });
        break;
      }
      default: {
        const indent = "indent" in token ? token.indent : -1;
        const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type, indent, source, end });
      }
    }
  }
  exports.createScalarToken = createScalarToken;
  exports.resolveAsScalar = resolveAsScalar;
  exports.setScalarValue = setScalarValue;
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS((exports) => {
  var stringify = (cst) => ("type" in cst) ? stringifyToken(cst) : stringifyItem(cst);
  function stringifyToken(token) {
    switch (token.type) {
      case "block-scalar": {
        let res = "";
        for (const tok of token.props)
          res += stringifyToken(tok);
        return res + token.source;
      }
      case "block-map":
      case "block-seq": {
        let res = "";
        for (const item of token.items)
          res += stringifyItem(item);
        return res;
      }
      case "flow-collection": {
        let res = token.start.source;
        for (const item of token.items)
          res += stringifyItem(item);
        for (const st of token.end)
          res += st.source;
        return res;
      }
      case "document": {
        let res = stringifyItem(token);
        if (token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
      default: {
        let res = token.source;
        if ("end" in token && token.end)
          for (const st of token.end)
            res += st.source;
        return res;
      }
    }
  }
  function stringifyItem({ start, key, sep: sep3, value }) {
    let res = "";
    for (const st of start)
      res += st.source;
    if (key)
      res += stringifyToken(key);
    if (sep3)
      for (const st of sep3)
        res += st.source;
    if (value)
      res += stringifyToken(value);
    return res;
  }
  exports.stringify = stringify;
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS((exports) => {
  var BREAK = Symbol("break visit");
  var SKIP = Symbol("skip children");
  var REMOVE = Symbol("remove item");
  function visit(cst, visitor) {
    if ("type" in cst && cst.type === "document")
      cst = { start: cst.start, value: cst.value };
    _visit(Object.freeze([]), cst, visitor);
  }
  visit.BREAK = BREAK;
  visit.SKIP = SKIP;
  visit.REMOVE = REMOVE;
  visit.itemAtPath = (cst, path) => {
    let item = cst;
    for (const [field, index] of path) {
      const tok = item?.[field];
      if (tok && "items" in tok) {
        item = tok.items[index];
      } else
        return;
    }
    return item;
  };
  visit.parentCollection = (cst, path) => {
    const parent = visit.itemAtPath(cst, path.slice(0, -1));
    const field = path[path.length - 1][0];
    const coll = parent?.[field];
    if (coll && "items" in coll)
      return coll;
    throw new Error("Parent collection not found");
  };
  function _visit(path, item, visitor) {
    let ctrl = visitor(item, path);
    if (typeof ctrl === "symbol")
      return ctrl;
    for (const field of ["key", "value"]) {
      const token = item[field];
      if (token && "items" in token) {
        for (let i = 0;i < token.items.length; ++i) {
          const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
          if (typeof ci === "number")
            i = ci - 1;
          else if (ci === BREAK)
            return BREAK;
          else if (ci === REMOVE) {
            token.items.splice(i, 1);
            i -= 1;
          }
        }
        if (typeof ctrl === "function" && field === "key")
          ctrl = ctrl(item, path);
      }
    }
    return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
  }
  exports.visit = visit;
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS((exports) => {
  var cstScalar = require_cst_scalar();
  var cstStringify = require_cst_stringify();
  var cstVisit = require_cst_visit();
  var BOM = "\uFEFF";
  var DOCUMENT = "\x02";
  var FLOW_END = "\x18";
  var SCALAR = "\x1F";
  var isCollection = (token) => !!token && ("items" in token);
  var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
  function prettyToken(token) {
    switch (token) {
      case BOM:
        return "<BOM>";
      case DOCUMENT:
        return "<DOC>";
      case FLOW_END:
        return "<FLOW_END>";
      case SCALAR:
        return "<SCALAR>";
      default:
        return JSON.stringify(token);
    }
  }
  function tokenType(source) {
    switch (source) {
      case BOM:
        return "byte-order-mark";
      case DOCUMENT:
        return "doc-mode";
      case FLOW_END:
        return "flow-error-end";
      case SCALAR:
        return "scalar";
      case "---":
        return "doc-start";
      case "...":
        return "doc-end";
      case "":
      case `
`:
      case `\r
`:
        return "newline";
      case "-":
        return "seq-item-ind";
      case "?":
        return "explicit-key-ind";
      case ":":
        return "map-value-ind";
      case "{":
        return "flow-map-start";
      case "}":
        return "flow-map-end";
      case "[":
        return "flow-seq-start";
      case "]":
        return "flow-seq-end";
      case ",":
        return "comma";
    }
    switch (source[0]) {
      case " ":
      case "\t":
        return "space";
      case "#":
        return "comment";
      case "%":
        return "directive-line";
      case "*":
        return "alias";
      case "&":
        return "anchor";
      case "!":
        return "tag";
      case "'":
        return "single-quoted-scalar";
      case '"':
        return "double-quoted-scalar";
      case "|":
      case ">":
        return "block-scalar-header";
    }
    return null;
  }
  exports.createScalarToken = cstScalar.createScalarToken;
  exports.resolveAsScalar = cstScalar.resolveAsScalar;
  exports.setScalarValue = cstScalar.setScalarValue;
  exports.stringify = cstStringify.stringify;
  exports.visit = cstVisit.visit;
  exports.BOM = BOM;
  exports.DOCUMENT = DOCUMENT;
  exports.FLOW_END = FLOW_END;
  exports.SCALAR = SCALAR;
  exports.isCollection = isCollection;
  exports.isScalar = isScalar;
  exports.prettyToken = prettyToken;
  exports.tokenType = tokenType;
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS((exports) => {
  var cst = require_cst();
  function isEmpty(ch) {
    switch (ch) {
      case undefined:
      case " ":
      case `
`:
      case "\r":
      case "\t":
        return true;
      default:
        return false;
    }
  }
  var hexDigits = new Set("0123456789ABCDEFabcdef");
  var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
  var flowIndicatorChars = new Set(",[]{}");
  var invalidAnchorChars = new Set(` ,[]{}
\r	`);
  var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);

  class Lexer {
    constructor() {
      this.atEnd = false;
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      this.buffer = "";
      this.flowKey = false;
      this.flowLevel = 0;
      this.indentNext = 0;
      this.indentValue = 0;
      this.lineEndPos = null;
      this.next = null;
      this.pos = 0;
    }
    *lex(source, incomplete = false) {
      if (source) {
        if (typeof source !== "string")
          throw TypeError("source is not a string");
        this.buffer = this.buffer ? this.buffer + source : source;
        this.lineEndPos = null;
      }
      this.atEnd = !incomplete;
      let next = this.next ?? "stream";
      while (next && (incomplete || this.hasChars(1)))
        next = yield* this.parseNext(next);
    }
    atLineEnd() {
      let i = this.pos;
      let ch = this.buffer[i];
      while (ch === " " || ch === "\t")
        ch = this.buffer[++i];
      if (!ch || ch === "#" || ch === `
`)
        return true;
      if (ch === "\r")
        return this.buffer[i + 1] === `
`;
      return false;
    }
    charAt(n) {
      return this.buffer[this.pos + n];
    }
    continueScalar(offset) {
      let ch = this.buffer[offset];
      if (this.indentNext > 0) {
        let indent = 0;
        while (ch === " ")
          ch = this.buffer[++indent + offset];
        if (ch === "\r") {
          const next = this.buffer[indent + offset + 1];
          if (next === `
` || !next && !this.atEnd)
            return offset + indent + 1;
        }
        return ch === `
` || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
      }
      if (ch === "-" || ch === ".") {
        const dt = this.buffer.substr(offset, 3);
        if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
          return -1;
      }
      return offset;
    }
    getLine() {
      let end = this.lineEndPos;
      if (typeof end !== "number" || end !== -1 && end < this.pos) {
        end = this.buffer.indexOf(`
`, this.pos);
        this.lineEndPos = end;
      }
      if (end === -1)
        return this.atEnd ? this.buffer.substring(this.pos) : null;
      if (this.buffer[end - 1] === "\r")
        end -= 1;
      return this.buffer.substring(this.pos, end);
    }
    hasChars(n) {
      return this.pos + n <= this.buffer.length;
    }
    setNext(state) {
      this.buffer = this.buffer.substring(this.pos);
      this.pos = 0;
      this.lineEndPos = null;
      this.next = state;
      return null;
    }
    peek(n) {
      return this.buffer.substr(this.pos, n);
    }
    *parseNext(next) {
      switch (next) {
        case "stream":
          return yield* this.parseStream();
        case "line-start":
          return yield* this.parseLineStart();
        case "block-start":
          return yield* this.parseBlockStart();
        case "doc":
          return yield* this.parseDocument();
        case "flow":
          return yield* this.parseFlowCollection();
        case "quoted-scalar":
          return yield* this.parseQuotedScalar();
        case "block-scalar":
          return yield* this.parseBlockScalar();
        case "plain-scalar":
          return yield* this.parsePlainScalar();
      }
    }
    *parseStream() {
      let line = this.getLine();
      if (line === null)
        return this.setNext("stream");
      if (line[0] === cst.BOM) {
        yield* this.pushCount(1);
        line = line.substring(1);
      }
      if (line[0] === "%") {
        let dirEnd = line.length;
        let cs = line.indexOf("#");
        while (cs !== -1) {
          const ch = line[cs - 1];
          if (ch === " " || ch === "\t") {
            dirEnd = cs - 1;
            break;
          } else {
            cs = line.indexOf("#", cs + 1);
          }
        }
        while (true) {
          const ch = line[dirEnd - 1];
          if (ch === " " || ch === "\t")
            dirEnd -= 1;
          else
            break;
        }
        const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
        yield* this.pushCount(line.length - n);
        this.pushNewline();
        return "stream";
      }
      if (this.atLineEnd()) {
        const sp = yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - sp);
        yield* this.pushNewline();
        return "stream";
      }
      yield cst.DOCUMENT;
      return yield* this.parseLineStart();
    }
    *parseLineStart() {
      const ch = this.charAt(0);
      if (!ch && !this.atEnd)
        return this.setNext("line-start");
      if (ch === "-" || ch === ".") {
        if (!this.atEnd && !this.hasChars(4))
          return this.setNext("line-start");
        const s = this.peek(3);
        if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
          yield* this.pushCount(3);
          this.indentValue = 0;
          this.indentNext = 0;
          return s === "---" ? "doc" : "stream";
        }
      }
      this.indentValue = yield* this.pushSpaces(false);
      if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
        this.indentNext = this.indentValue;
      return yield* this.parseBlockStart();
    }
    *parseBlockStart() {
      const [ch0, ch1] = this.peek(2);
      if (!ch1 && !this.atEnd)
        return this.setNext("block-start");
      if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
        const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
        this.indentNext = this.indentValue + 1;
        this.indentValue += n;
        return "block-start";
      }
      return "doc";
    }
    *parseDocument() {
      yield* this.pushSpaces(true);
      const line = this.getLine();
      if (line === null)
        return this.setNext("doc");
      let n = yield* this.pushIndicators();
      switch (line[n]) {
        case "#":
          yield* this.pushCount(line.length - n);
        case undefined:
          yield* this.pushNewline();
          return yield* this.parseLineStart();
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel = 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          return "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "doc";
        case '"':
        case "'":
          return yield* this.parseQuotedScalar();
        case "|":
        case ">":
          n += yield* this.parseBlockScalarHeader();
          n += yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - n);
          yield* this.pushNewline();
          return yield* this.parseBlockScalar();
        default:
          return yield* this.parsePlainScalar();
      }
    }
    *parseFlowCollection() {
      let nl, sp;
      let indent = -1;
      do {
        nl = yield* this.pushNewline();
        if (nl > 0) {
          sp = yield* this.pushSpaces(false);
          this.indentValue = indent = sp;
        } else {
          sp = 0;
        }
        sp += yield* this.pushSpaces(true);
      } while (nl + sp > 0);
      const line = this.getLine();
      if (line === null)
        return this.setNext("flow");
      if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
        const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
        if (!atFlowEndMarker) {
          this.flowLevel = 0;
          yield cst.FLOW_END;
          return yield* this.parseLineStart();
        }
      }
      let n = 0;
      while (line[n] === ",") {
        n += yield* this.pushCount(1);
        n += yield* this.pushSpaces(true);
        this.flowKey = false;
      }
      n += yield* this.pushIndicators();
      switch (line[n]) {
        case undefined:
          return "flow";
        case "#":
          yield* this.pushCount(line.length - n);
          return "flow";
        case "{":
        case "[":
          yield* this.pushCount(1);
          this.flowKey = false;
          this.flowLevel += 1;
          return "flow";
        case "}":
        case "]":
          yield* this.pushCount(1);
          this.flowKey = true;
          this.flowLevel -= 1;
          return this.flowLevel ? "flow" : "doc";
        case "*":
          yield* this.pushUntil(isNotAnchorChar);
          return "flow";
        case '"':
        case "'":
          this.flowKey = true;
          return yield* this.parseQuotedScalar();
        case ":": {
          const next = this.charAt(1);
          if (this.flowKey || isEmpty(next) || next === ",") {
            this.flowKey = false;
            yield* this.pushCount(1);
            yield* this.pushSpaces(true);
            return "flow";
          }
        }
        default:
          this.flowKey = false;
          return yield* this.parsePlainScalar();
      }
    }
    *parseQuotedScalar() {
      const quote = this.charAt(0);
      let end = this.buffer.indexOf(quote, this.pos + 1);
      if (quote === "'") {
        while (end !== -1 && this.buffer[end + 1] === "'")
          end = this.buffer.indexOf("'", end + 2);
      } else {
        while (end !== -1) {
          let n = 0;
          while (this.buffer[end - 1 - n] === "\\")
            n += 1;
          if (n % 2 === 0)
            break;
          end = this.buffer.indexOf('"', end + 1);
        }
      }
      const qb = this.buffer.substring(0, end);
      let nl = qb.indexOf(`
`, this.pos);
      if (nl !== -1) {
        while (nl !== -1) {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = qb.indexOf(`
`, cs);
        }
        if (nl !== -1) {
          end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
        }
      }
      if (end === -1) {
        if (!this.atEnd)
          return this.setNext("quoted-scalar");
        end = this.buffer.length;
      }
      yield* this.pushToIndex(end + 1, false);
      return this.flowLevel ? "flow" : "doc";
    }
    *parseBlockScalarHeader() {
      this.blockScalarIndent = -1;
      this.blockScalarKeep = false;
      let i = this.pos;
      while (true) {
        const ch = this.buffer[++i];
        if (ch === "+")
          this.blockScalarKeep = true;
        else if (ch > "0" && ch <= "9")
          this.blockScalarIndent = Number(ch) - 1;
        else if (ch !== "-")
          break;
      }
      return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
    }
    *parseBlockScalar() {
      let nl = this.pos - 1;
      let indent = 0;
      let ch;
      loop:
        for (let i2 = this.pos;ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case `
`:
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === `
`)
                break;
            }
            default:
              break loop;
          }
        }
      if (!ch && !this.atEnd)
        return this.setNext("block-scalar");
      if (indent >= this.indentNext) {
        if (this.blockScalarIndent === -1)
          this.indentNext = indent;
        else {
          this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
        }
        do {
          const cs = this.continueScalar(nl + 1);
          if (cs === -1)
            break;
          nl = this.buffer.indexOf(`
`, cs);
        } while (nl !== -1);
        if (nl === -1) {
          if (!this.atEnd)
            return this.setNext("block-scalar");
          nl = this.buffer.length;
        }
      }
      let i = nl + 1;
      ch = this.buffer[i];
      while (ch === " ")
        ch = this.buffer[++i];
      if (ch === "\t") {
        while (ch === "\t" || ch === " " || ch === "\r" || ch === `
`)
          ch = this.buffer[++i];
        nl = i - 1;
      } else if (!this.blockScalarKeep) {
        do {
          let i2 = nl - 1;
          let ch2 = this.buffer[i2];
          if (ch2 === "\r")
            ch2 = this.buffer[--i2];
          const lastChar = i2;
          while (ch2 === " ")
            ch2 = this.buffer[--i2];
          if (ch2 === `
` && i2 >= this.pos && i2 + 1 + indent > lastChar)
            nl = i2;
          else
            break;
        } while (true);
      }
      yield cst.SCALAR;
      yield* this.pushToIndex(nl + 1, true);
      return yield* this.parseLineStart();
    }
    *parsePlainScalar() {
      const inFlow = this.flowLevel > 0;
      let end = this.pos - 1;
      let i = this.pos - 1;
      let ch;
      while (ch = this.buffer[++i]) {
        if (ch === ":") {
          const next = this.buffer[i + 1];
          if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
            break;
          end = i;
        } else if (isEmpty(ch)) {
          let next = this.buffer[i + 1];
          if (ch === "\r") {
            if (next === `
`) {
              i += 1;
              ch = `
`;
              next = this.buffer[i + 1];
            } else
              end = i;
          }
          if (next === "#" || inFlow && flowIndicatorChars.has(next))
            break;
          if (ch === `
`) {
            const cs = this.continueScalar(i + 1);
            if (cs === -1)
              break;
            i = Math.max(i, cs - 2);
          }
        } else {
          if (inFlow && flowIndicatorChars.has(ch))
            break;
          end = i;
        }
      }
      if (!ch && !this.atEnd)
        return this.setNext("plain-scalar");
      yield cst.SCALAR;
      yield* this.pushToIndex(end + 1, true);
      return inFlow ? "flow" : "doc";
    }
    *pushCount(n) {
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos += n;
        return n;
      }
      return 0;
    }
    *pushToIndex(i, allowEmpty) {
      const s = this.buffer.slice(this.pos, i);
      if (s) {
        yield s;
        this.pos += s.length;
        return s.length;
      } else if (allowEmpty)
        yield "";
      return 0;
    }
    *pushIndicators() {
      let n = 0;
      loop:
        while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            case "?":
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
      return n;
    }
    *pushTag() {
      if (this.charAt(1) === "<") {
        let i = this.pos + 2;
        let ch = this.buffer[i];
        while (!isEmpty(ch) && ch !== ">")
          ch = this.buffer[++i];
        return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
      } else {
        let i = this.pos + 1;
        let ch = this.buffer[i];
        while (ch) {
          if (tagChars.has(ch))
            ch = this.buffer[++i];
          else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
            ch = this.buffer[i += 3];
          } else
            break;
        }
        return yield* this.pushToIndex(i, false);
      }
    }
    *pushNewline() {
      const ch = this.buffer[this.pos];
      if (ch === `
`)
        return yield* this.pushCount(1);
      else if (ch === "\r" && this.charAt(1) === `
`)
        return yield* this.pushCount(2);
      else
        return 0;
    }
    *pushSpaces(allowTabs) {
      let i = this.pos - 1;
      let ch;
      do {
        ch = this.buffer[++i];
      } while (ch === " " || allowTabs && ch === "\t");
      const n = i - this.pos;
      if (n > 0) {
        yield this.buffer.substr(this.pos, n);
        this.pos = i;
      }
      return n;
    }
    *pushUntil(test) {
      let i = this.pos;
      let ch = this.buffer[i];
      while (!test(ch))
        ch = this.buffer[++i];
      return yield* this.pushToIndex(i, false);
    }
  }
  exports.Lexer = Lexer;
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS((exports) => {
  class LineCounter {
    constructor() {
      this.lineStarts = [];
      this.addNewLine = (offset) => this.lineStarts.push(offset);
      this.linePos = (offset) => {
        let low = 0;
        let high = this.lineStarts.length;
        while (low < high) {
          const mid = low + high >> 1;
          if (this.lineStarts[mid] < offset)
            low = mid + 1;
          else
            high = mid;
        }
        if (this.lineStarts[low] === offset)
          return { line: low + 1, col: 1 };
        if (low === 0)
          return { line: 0, col: offset };
        const start = this.lineStarts[low - 1];
        return { line: low, col: offset - start + 1 };
      };
    }
  }
  exports.LineCounter = LineCounter;
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS((exports) => {
  var node_process = __require("process");
  var cst = require_cst();
  var lexer = require_lexer();
  function includesToken(list, type) {
    for (let i = 0;i < list.length; ++i)
      if (list[i].type === type)
        return true;
    return false;
  }
  function findNonEmptyIndex(list) {
    for (let i = 0;i < list.length; ++i) {
      switch (list[i].type) {
        case "space":
        case "comment":
        case "newline":
          break;
        default:
          return i;
      }
    }
    return -1;
  }
  function isFlowToken(token) {
    switch (token?.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "flow-collection":
        return true;
      default:
        return false;
    }
  }
  function getPrevProps(parent) {
    switch (parent.type) {
      case "document":
        return parent.start;
      case "block-map": {
        const it = parent.items[parent.items.length - 1];
        return it.sep ?? it.start;
      }
      case "block-seq":
        return parent.items[parent.items.length - 1].start;
      default:
        return [];
    }
  }
  function getFirstKeyStartProps(prev) {
    if (prev.length === 0)
      return [];
    let i = prev.length;
    loop:
      while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
    while (prev[++i]?.type === "space") {}
    return prev.splice(i, prev.length);
  }
  function arrayPushArray(target, source) {
    if (source.length < 1e5)
      Array.prototype.push.apply(target, source);
    else
      for (let i = 0;i < source.length; ++i)
        target.push(source[i]);
  }
  function fixFlowSeqItems(fc) {
    if (fc.start.type === "flow-seq-start") {
      for (const it of fc.items) {
        if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
          if (it.key)
            it.value = it.key;
          delete it.key;
          if (isFlowToken(it.value)) {
            if (it.value.end)
              arrayPushArray(it.value.end, it.sep);
            else
              it.value.end = it.sep;
          } else
            arrayPushArray(it.start, it.sep);
          delete it.sep;
        }
      }
    }
  }

  class Parser {
    constructor(onNewLine) {
      this.atNewLine = true;
      this.atScalar = false;
      this.indent = 0;
      this.offset = 0;
      this.onKeyLine = false;
      this.stack = [];
      this.source = "";
      this.type = "";
      this.lexer = new lexer.Lexer;
      this.onNewLine = onNewLine;
    }
    *parse(source, incomplete = false) {
      if (this.onNewLine && this.offset === 0)
        this.onNewLine(0);
      for (const lexeme of this.lexer.lex(source, incomplete))
        yield* this.next(lexeme);
      if (!incomplete)
        yield* this.end();
    }
    *next(source) {
      this.source = source;
      if (node_process.env.LOG_TOKENS)
        console.log("|", cst.prettyToken(source));
      if (this.atScalar) {
        this.atScalar = false;
        yield* this.step();
        this.offset += source.length;
        return;
      }
      const type = cst.tokenType(source);
      if (!type) {
        const message = `Not a YAML token: ${source}`;
        yield* this.pop({ type: "error", offset: this.offset, message, source });
        this.offset += source.length;
      } else if (type === "scalar") {
        this.atNewLine = false;
        this.atScalar = true;
        this.type = "scalar";
      } else {
        this.type = type;
        yield* this.step();
        switch (type) {
          case "newline":
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine)
              this.onNewLine(this.offset + source.length);
            break;
          case "space":
            if (this.atNewLine && source[0] === " ")
              this.indent += source.length;
            break;
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
            if (this.atNewLine)
              this.indent += source.length;
            break;
          case "doc-mode":
          case "flow-error-end":
            return;
          default:
            this.atNewLine = false;
        }
        this.offset += source.length;
      }
    }
    *end() {
      while (this.stack.length > 0)
        yield* this.pop();
    }
    get sourceToken() {
      const st = {
        type: this.type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
      return st;
    }
    *step() {
      const top = this.peek(1);
      if (this.type === "doc-end" && top?.type !== "doc-end") {
        while (this.stack.length > 0)
          yield* this.pop();
        this.stack.push({
          type: "doc-end",
          offset: this.offset,
          source: this.source
        });
        return;
      }
      if (!top)
        return yield* this.stream();
      switch (top.type) {
        case "document":
          return yield* this.document(top);
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return yield* this.scalar(top);
        case "block-scalar":
          return yield* this.blockScalar(top);
        case "block-map":
          return yield* this.blockMap(top);
        case "block-seq":
          return yield* this.blockSequence(top);
        case "flow-collection":
          return yield* this.flowCollection(top);
        case "doc-end":
          return yield* this.documentEnd(top);
      }
      yield* this.pop();
    }
    peek(n) {
      return this.stack[this.stack.length - n];
    }
    *pop(error) {
      const token = error ?? this.stack.pop();
      if (!token) {
        const message = "Tried to pop an empty stack";
        yield { type: "error", offset: this.offset, source: "", message };
      } else if (this.stack.length === 0) {
        yield token;
      } else {
        const top = this.peek(1);
        if (token.type === "block-scalar") {
          token.indent = "indent" in top ? top.indent : 0;
        } else if (token.type === "flow-collection" && top.type === "document") {
          token.indent = 0;
        }
        if (token.type === "flow-collection")
          fixFlowSeqItems(token);
        switch (top.type) {
          case "document":
            top.value = token;
            break;
          case "block-scalar":
            top.props.push(token);
            break;
          case "block-map": {
            const it = top.items[top.items.length - 1];
            if (it.value) {
              top.items.push({ start: [], key: token, sep: [] });
              this.onKeyLine = true;
              return;
            } else if (it.sep) {
              it.value = token;
            } else {
              Object.assign(it, { key: token, sep: [] });
              this.onKeyLine = !it.explicitKey;
              return;
            }
            break;
          }
          case "block-seq": {
            const it = top.items[top.items.length - 1];
            if (it.value)
              top.items.push({ start: [], value: token });
            else
              it.value = token;
            break;
          }
          case "flow-collection": {
            const it = top.items[top.items.length - 1];
            if (!it || it.value)
              top.items.push({ start: [], key: token, sep: [] });
            else if (it.sep)
              it.value = token;
            else
              Object.assign(it, { key: token, sep: [] });
            return;
          }
          default:
            yield* this.pop();
            yield* this.pop(token);
        }
        if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
          const last = token.items[token.items.length - 1];
          if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
            if (top.type === "document")
              top.end = last.start;
            else
              top.items.push({ start: last.start });
            token.items.splice(-1, 1);
          }
        }
      }
    }
    *stream() {
      switch (this.type) {
        case "directive-line":
          yield { type: "directive", offset: this.offset, source: this.source };
          return;
        case "byte-order-mark":
        case "space":
        case "comment":
        case "newline":
          yield this.sourceToken;
          return;
        case "doc-mode":
        case "doc-start": {
          const doc = {
            type: "document",
            offset: this.offset,
            start: []
          };
          if (this.type === "doc-start")
            doc.start.push(this.sourceToken);
          this.stack.push(doc);
          return;
        }
      }
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML stream`,
        source: this.source
      };
    }
    *document(doc) {
      if (doc.value)
        return yield* this.lineEnd(doc);
      switch (this.type) {
        case "doc-start": {
          if (findNonEmptyIndex(doc.start) !== -1) {
            yield* this.pop();
            yield* this.step();
          } else
            doc.start.push(this.sourceToken);
          return;
        }
        case "anchor":
        case "tag":
        case "space":
        case "comment":
        case "newline":
          doc.start.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(doc);
      if (bv)
        this.stack.push(bv);
      else {
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML document`,
          source: this.source
        };
      }
    }
    *scalar(scalar) {
      if (this.type === "map-value-ind") {
        const prev = getPrevProps(this.peek(2));
        const start = getFirstKeyStartProps(prev);
        let sep3;
        if (scalar.end) {
          sep3 = scalar.end;
          sep3.push(this.sourceToken);
          delete scalar.end;
        } else
          sep3 = [this.sourceToken];
        const map = {
          type: "block-map",
          offset: scalar.offset,
          indent: scalar.indent,
          items: [{ start, key: scalar, sep: sep3 }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map;
      } else
        yield* this.lineEnd(scalar);
    }
    *blockScalar(scalar) {
      switch (this.type) {
        case "space":
        case "comment":
        case "newline":
          scalar.props.push(this.sourceToken);
          return;
        case "scalar":
          scalar.source = this.source;
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine) {
            let nl = this.source.indexOf(`
`) + 1;
            while (nl !== 0) {
              this.onNewLine(this.offset + nl);
              nl = this.source.indexOf(`
`, nl) + 1;
            }
          }
          yield* this.pop();
          break;
        default:
          yield* this.pop();
          yield* this.step();
      }
    }
    *blockMap(map) {
      const it = map.items[map.items.length - 1];
      switch (this.type) {
        case "newline":
          this.onKeyLine = false;
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "space":
        case "comment":
          if (it.value) {
            map.items.push({ start: [this.sourceToken] });
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            if (this.atIndentedComment(it.start, map.indent)) {
              const prev = map.items[map.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                arrayPushArray(end, it.start);
                end.push(this.sourceToken);
                map.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
      }
      if (this.indent >= map.indent) {
        const atMapIndent = !this.onKeyLine && this.indent === map.indent;
        const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
        let start = [];
        if (atNextItem && it.sep && !it.value) {
          const nl = [];
          for (let i = 0;i < it.sep.length; ++i) {
            const st = it.sep[i];
            switch (st.type) {
              case "newline":
                nl.push(i);
                break;
              case "space":
                break;
              case "comment":
                if (st.indent > map.indent)
                  nl.length = 0;
                break;
              default:
                nl.length = 0;
            }
          }
          if (nl.length >= 2)
            start = it.sep.splice(nl[1]);
        }
        switch (this.type) {
          case "anchor":
          case "tag":
            if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start });
              this.onKeyLine = true;
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "explicit-key-ind":
            if (!it.sep && !it.explicitKey) {
              it.start.push(this.sourceToken);
              it.explicitKey = true;
            } else if (atNextItem || it.value) {
              start.push(this.sourceToken);
              map.items.push({ start, explicitKey: true });
            } else {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [this.sourceToken], explicitKey: true }]
              });
            }
            this.onKeyLine = true;
            return;
          case "map-value-ind":
            if (it.explicitKey) {
              if (!it.sep) {
                if (includesToken(it.start, "newline")) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else {
                  const start2 = getFirstKeyStartProps(it.start);
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                  });
                }
              } else if (it.value) {
                map.items.push({ start: [], key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start, key: null, sep: [this.sourceToken] }]
                });
              } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                const start2 = getFirstKeyStartProps(it.start);
                const key = it.key;
                const sep3 = it.sep;
                sep3.push(this.sourceToken);
                delete it.key;
                delete it.sep;
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key, sep: sep3 }]
                });
              } else if (start.length > 0) {
                it.sep = it.sep.concat(start, this.sourceToken);
              } else {
                it.sep.push(this.sourceToken);
              }
            } else {
              if (!it.sep) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else if (it.value || atNextItem) {
                map.items.push({ start, key: null, sep: [this.sourceToken] });
              } else if (includesToken(it.sep, "map-value-ind")) {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [], key: null, sep: [this.sourceToken] }]
                });
              } else {
                it.sep.push(this.sourceToken);
              }
            }
            this.onKeyLine = true;
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (atNextItem || it.value) {
              map.items.push({ start, key: fs, sep: [] });
              this.onKeyLine = true;
            } else if (it.sep) {
              this.stack.push(fs);
            } else {
              Object.assign(it, { key: fs, sep: [] });
              this.onKeyLine = true;
            }
            return;
          }
          default: {
            const bv = this.startBlockValue(map);
            if (bv) {
              if (bv.type === "block-seq") {
                if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                  yield* this.pop({
                    type: "error",
                    offset: this.offset,
                    message: "Unexpected block-seq-ind on same line with key",
                    source: this.source
                  });
                  return;
                }
              } else if (atMapIndent) {
                map.items.push({ start });
              }
              this.stack.push(bv);
              return;
            }
          }
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *blockSequence(seq) {
      const it = seq.items[seq.items.length - 1];
      switch (this.type) {
        case "newline":
          if (it.value) {
            const end = "end" in it.value ? it.value.end : undefined;
            const last = Array.isArray(end) ? end[end.length - 1] : undefined;
            if (last?.type === "comment")
              end?.push(this.sourceToken);
            else
              seq.items.push({ start: [this.sourceToken] });
          } else
            it.start.push(this.sourceToken);
          return;
        case "space":
        case "comment":
          if (it.value)
            seq.items.push({ start: [this.sourceToken] });
          else {
            if (this.atIndentedComment(it.start, seq.indent)) {
              const prev = seq.items[seq.items.length - 2];
              const end = prev?.value?.end;
              if (Array.isArray(end)) {
                arrayPushArray(end, it.start);
                end.push(this.sourceToken);
                seq.items.pop();
                return;
              }
            }
            it.start.push(this.sourceToken);
          }
          return;
        case "anchor":
        case "tag":
          if (it.value || this.indent <= seq.indent)
            break;
          it.start.push(this.sourceToken);
          return;
        case "seq-item-ind":
          if (this.indent !== seq.indent)
            break;
          if (it.value || includesToken(it.start, "seq-item-ind"))
            seq.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
      }
      if (this.indent > seq.indent) {
        const bv = this.startBlockValue(seq);
        if (bv) {
          this.stack.push(bv);
          return;
        }
      }
      yield* this.pop();
      yield* this.step();
    }
    *flowCollection(fc) {
      const it = fc.items[fc.items.length - 1];
      if (this.type === "flow-error-end") {
        let top;
        do {
          yield* this.pop();
          top = this.peek(1);
        } while (top?.type === "flow-collection");
      } else if (fc.end.length === 0) {
        switch (this.type) {
          case "comma":
          case "explicit-key-ind":
            if (!it || it.sep)
              fc.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
          case "map-value-ind":
            if (!it || it.value)
              fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            return;
          case "space":
          case "comment":
          case "newline":
          case "anchor":
          case "tag":
            if (!it || it.value)
              fc.items.push({ start: [this.sourceToken] });
            else if (it.sep)
              it.sep.push(this.sourceToken);
            else
              it.start.push(this.sourceToken);
            return;
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar": {
            const fs = this.flowScalar(this.type);
            if (!it || it.value)
              fc.items.push({ start: [], key: fs, sep: [] });
            else if (it.sep)
              this.stack.push(fs);
            else
              Object.assign(it, { key: fs, sep: [] });
            return;
          }
          case "flow-map-end":
          case "flow-seq-end":
            fc.end.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(fc);
        if (bv)
          this.stack.push(bv);
        else {
          yield* this.pop();
          yield* this.step();
        }
      } else {
        const parent = this.peek(2);
        if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
          yield* this.pop();
          yield* this.step();
        } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          fixFlowSeqItems(fc);
          const sep3 = fc.end.splice(1, fc.end.length);
          sep3.push(this.sourceToken);
          const map = {
            type: "block-map",
            offset: fc.offset,
            indent: fc.indent,
            items: [{ start, key: fc, sep: sep3 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else {
          yield* this.lineEnd(fc);
        }
      }
    }
    flowScalar(type) {
      if (this.onNewLine) {
        let nl = this.source.indexOf(`
`) + 1;
        while (nl !== 0) {
          this.onNewLine(this.offset + nl);
          nl = this.source.indexOf(`
`, nl) + 1;
        }
      }
      return {
        type,
        offset: this.offset,
        indent: this.indent,
        source: this.source
      };
    }
    startBlockValue(parent) {
      switch (this.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
          return this.flowScalar(this.type);
        case "block-scalar-header":
          return {
            type: "block-scalar",
            offset: this.offset,
            indent: this.indent,
            props: [this.sourceToken],
            source: ""
          };
        case "flow-map-start":
        case "flow-seq-start":
          return {
            type: "flow-collection",
            offset: this.offset,
            indent: this.indent,
            start: this.sourceToken,
            items: [],
            end: []
          };
        case "seq-item-ind":
          return {
            type: "block-seq",
            offset: this.offset,
            indent: this.indent,
            items: [{ start: [this.sourceToken] }]
          };
        case "explicit-key-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          start.push(this.sourceToken);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, explicitKey: true }]
          };
        }
        case "map-value-ind": {
          this.onKeyLine = true;
          const prev = getPrevProps(parent);
          const start = getFirstKeyStartProps(prev);
          return {
            type: "block-map",
            offset: this.offset,
            indent: this.indent,
            items: [{ start, key: null, sep: [this.sourceToken] }]
          };
        }
      }
      return null;
    }
    atIndentedComment(start, indent) {
      if (this.type !== "comment")
        return false;
      if (this.indent <= indent)
        return false;
      return start.every((st) => st.type === "newline" || st.type === "space");
    }
    *documentEnd(docEnd) {
      if (this.type !== "doc-mode") {
        if (docEnd.end)
          docEnd.end.push(this.sourceToken);
        else
          docEnd.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
      }
    }
    *lineEnd(token) {
      switch (this.type) {
        case "comma":
        case "doc-start":
        case "doc-end":
        case "flow-seq-end":
        case "flow-map-end":
        case "map-value-ind":
          yield* this.pop();
          yield* this.step();
          break;
        case "newline":
          this.onKeyLine = false;
        case "space":
        case "comment":
        default:
          if (token.end)
            token.end.push(this.sourceToken);
          else
            token.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
      }
    }
  }
  exports.Parser = Parser;
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS((exports) => {
  var composer = require_composer();
  var Document = require_Document();
  var errors = require_errors();
  var log = require_log();
  var identity = require_identity();
  var lineCounter = require_line_counter();
  var parser = require_parser();
  function parseOptions(options) {
    const prettyErrors = options.prettyErrors !== false;
    const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter || null;
    return { lineCounter: lineCounter$1, prettyErrors };
  }
  function parseAllDocuments(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    const docs = Array.from(composer$1.compose(parser$1.parse(source)));
    if (prettyErrors && lineCounter2)
      for (const doc of docs) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
    if (docs.length > 0)
      return docs;
    return Object.assign([], { empty: true }, composer$1.streamInfo());
  }
  function parseDocument(source, options = {}) {
    const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
    const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
    const composer$1 = new composer.Composer(options);
    let doc = null;
    for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
      if (!doc)
        doc = _doc;
      else if (doc.options.logLevel !== "silent") {
        doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
        break;
      }
    }
    if (prettyErrors && lineCounter2) {
      doc.errors.forEach(errors.prettifyError(source, lineCounter2));
      doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
    }
    return doc;
  }
  function parse(src, reviver, options) {
    let _reviver = undefined;
    if (typeof reviver === "function") {
      _reviver = reviver;
    } else if (options === undefined && reviver && typeof reviver === "object") {
      options = reviver;
    }
    const doc = parseDocument(src, options);
    if (!doc)
      return null;
    doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
    if (doc.errors.length > 0) {
      if (doc.options.logLevel !== "silent")
        throw doc.errors[0];
      else
        doc.errors = [];
    }
    return doc.toJS(Object.assign({ reviver: _reviver }, options));
  }
  function stringify(value, replacer, options) {
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === undefined && replacer) {
      options = replacer;
    }
    if (typeof options === "string")
      options = options.length;
    if (typeof options === "number") {
      const indent = Math.round(options);
      options = indent < 1 ? undefined : indent > 8 ? { indent: 8 } : { indent };
    }
    if (value === undefined) {
      const { keepUndefined } = options ?? replacer ?? {};
      if (!keepUndefined)
        return;
    }
    if (identity.isDocument(value) && !_replacer)
      return value.toString(options);
    return new Document.Document(value, _replacer, options).toString(options);
  }
  exports.parse = parse;
  exports.parseAllDocuments = parseAllDocuments;
  exports.parseDocument = parseDocument;
  exports.stringify = stringify;
});

// src/specialist/script-runner.ts
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash4, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync as existsSync11,
  fstatSync,
  lstatSync as lstatSync2,
  openSync,
  readFileSync as readFileSync6,
  realpathSync
} from "node:fs";
import { homedir as homedir4 } from "node:os";
import { isAbsolute as isAbsolute2, join as join7, relative, resolve as resolve9 } from "node:path";

// src/pi/session.ts
import { createHash } from "node:crypto";

// src/pi/read-line-numbers-extension.ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname(fileURLToPath(import.meta.url));
var REL = join("config", "pi-extensions", "read-line-numbers");
var CANDIDATES = [
  join(HERE, "..", REL),
  join(HERE, "..", "..", REL),
  join(HERE, "..", "..", "..", REL)
];
var cached;
function getReadLineNumbersExtensionPath() {
  if (cached !== undefined)
    return cached;
  for (const candidate of CANDIDATES) {
    if (existsSync(join(candidate, "index.mjs"))) {
      cached = resolve(candidate);
      return cached;
    }
  }
  cached = null;
  process.stderr.write("[read-line-numbers] WARN: bundled extension not found alongside package. " + `Model-facing read output will not be line-numbered for this session.
`);
  return cached;
}

// src/pi/extension-tool-policy-extension.ts
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var HERE2 = dirname2(fileURLToPath2(import.meta.url));
var REL2 = join2("config", "pi-extensions", "extension-tool-policy");
var CANDIDATES2 = [
  join2(HERE2, "..", REL2),
  join2(HERE2, "..", "..", REL2),
  join2(HERE2, "..", "..", "..", REL2)
];
var cached2;
function getExtensionToolPolicyExtensionPath() {
  if (cached2 !== undefined)
    return cached2;
  for (const candidate of CANDIDATES2) {
    if (existsSync2(join2(candidate, "index.mjs"))) {
      cached2 = resolve2(candidate);
      return cached2;
    }
  }
  cached2 = null;
  process.stderr.write("[xtrm-tool-policy] WARN: bundled policy extension not found alongside package. " + `Enabled extension sources will load without the tool-policy gate.
`);
  return cached2;
}
var NATIVE_TOOLS_ENV_KEY = "PI_SPECIALIST_ALLOWED_NATIVE_TOOLS";

// src/pi/python-kernel-extension.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname3, join as join3, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { homedir } from "node:os";
var HERE3 = dirname3(fileURLToPath3(import.meta.url));
var PACKAGE_DIR = join3("@jaggerxtrm", "pi-extensions");
var EXT_REL = join3("extensions", "python-kernel", "index.ts");
function resolveGlobalNodeModulesDir() {
  const candidates = [
    process.env.PI_NPM_GLOBAL_DIR,
    process.env.NPM_CONFIG_PREFIX ? join3(process.env.NPM_CONFIG_PREFIX, "lib", "node_modules") : undefined,
    process.env.npm_config_prefix ? join3(process.env.npm_config_prefix, "lib", "node_modules") : undefined,
    process.env.NVM_BIN ? join3(dirname3(process.env.NVM_BIN), "lib", "node_modules") : undefined,
    join3(homedir(), ".nvm/versions/node", process.version, "lib", "node_modules")
  ].filter((candidate) => Boolean(candidate));
  return candidates.find((candidate) => existsSync3(candidate));
}
var cached3;
function getPiExtensionsPythonKernelPath() {
  if (cached3 !== undefined)
    return cached3;
  const globalDir = resolveGlobalNodeModulesDir();
  if (globalDir) {
    const candidate = join3(globalDir, PACKAGE_DIR, EXT_REL);
    if (existsSync3(candidate)) {
      cached3 = resolve3(candidate);
      return cached3;
    }
  }
  cached3 = null;
  return cached3;
}
function resolvePiExtensionsPythonKernelPath() {
  return getPiExtensionsPythonKernelPath();
}
var SK_PACKAGE_DIR = join3("@jaggerxtrm", "pi-service-knowledge");

// src/pi/session.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync5, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as homedir2, tmpdir } from "node:os";
import { isAbsolute, resolve as resolve4, sep, join as join4, dirname as dirname4 } from "node:path";

// src/pi/backendMap.ts
var BACKEND_MAP = {
  gemini: "google-gemini-cli",
  google: "google-gemini-cli",
  claude: "anthropic",
  anthropic: "anthropic",
  openai: "openai",
  qwen: "openai",
  openrouter: "openrouter",
  groq: "groq"
};
function mapSpecialistBackend(model) {
  const provider = BACKEND_MAP[model.toLowerCase()];
  if (!provider) {
    return model.toLowerCase();
  }
  return provider;
}
function getProviderArgs(model) {
  const m = model.toLowerCase();
  if (m === "qwen") {
    return ["--api-key", process.env.DASHSCOPE_API_KEY ?? process.env.OPENAI_API_KEY ?? ""];
  }
  return [];
}

// src/specialist/canonical-asset-resolver.ts
import { existsSync as existsSync4 } from "node:fs";
import { fileURLToPath as fileURLToPath4 } from "node:url";
function resolveCanonicalAssetDir(relativePath) {
  const configPath = `config/${relativePath}`;
  let resolved = fileURLToPath4(new URL(`../${configPath}`, import.meta.url));
  if (existsSync4(resolved))
    return resolved;
  resolved = fileURLToPath4(new URL(`../../${configPath}`, import.meta.url));
  if (existsSync4(resolved))
    return resolved;
  return null;
}

// src/specialist/manifest-resolver.ts
var GITNEXUS_HARD_DENY_TOOLS = new Set(["grep", "find", "ls"]);
var GITNEXUS_BASE_TIER = "READ_ONLY";
function uniqueOrdered(values) {
  const seen = new Set;
  const ordered = [];
  for (const value of values) {
    if (seen.has(value))
      continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}
function getCatalog(catalogs, name) {
  return catalogs.find((catalog) => catalog.catalog === name);
}
function mergeTierPolicy(input) {
  const catalogPolicy = input.catalogDefaultOverrides?.[input.tier];
  const tierPolicy = input.manifestPolicy?.permissions?.[input.tier];
  const overridePolicy = input.specialistOverride;
  const specialistDenied = input.specialistExclusions?.deniedNatives ?? [];
  return {
    denied_natives_when_extension: uniqueOrdered([
      ...catalogPolicy?.denied_natives_when_extension ?? [],
      ...tierPolicy?.denied_natives_when_extension ?? [],
      ...overridePolicy?.denied_natives_when_extension ?? [],
      ...specialistDenied
    ]),
    denied_natives_mode: overridePolicy?.denied_natives_mode ?? tierPolicy?.denied_natives_mode ?? catalogPolicy?.denied_natives_mode ?? "soft"
  };
}
function getTierTools(catalogs, name, tier) {
  const catalog = getCatalog(catalogs, name);
  return catalog?.source_tiers[tier] ?? [];
}
function getEffectiveDeniedTools(tools) {
  return tools.filter((tool) => tool !== "read");
}
function resolveEffectiveExtensionState(state) {
  if (!state) {
    return { status: "available", includeTools: true, canEnforceHardDeny: true };
  }
  if (state.enabled === false || state.health === "disabled") {
    return { status: "disabled", includeTools: false, canEnforceHardDeny: false };
  }
  if (state.health === "not_installed") {
    return { status: "not_installed", includeTools: false, canEnforceHardDeny: false };
  }
  if (state.health === "loaded_unhealthy") {
    return { status: "loaded_unhealthy", includeTools: false, canEnforceHardDeny: false };
  }
  if (state.health === "unknown") {
    return { status: "unknown", includeTools: false, canEnforceHardDeny: false };
  }
  if (state.catalogCompatible === false) {
    return { status: "catalog_incompatible", includeTools: false, canEnforceHardDeny: false };
  }
  return { status: "available", includeTools: true, canEnforceHardDeny: true };
}
function resolveManifestTools(input) {
  const policy = mergeTierPolicy(input);
  const warnings = [];
  const attribution = [];
  const downgradeReasons = [];
  const effectiveDenied = new Set(getEffectiveDeniedTools(policy.denied_natives_when_extension ?? []));
  const hardDeniedTools = new Set(Array.from(effectiveDenied).filter((tool) => GITNEXUS_HARD_DENY_TOOLS.has(tool)));
  const deniedNatives = [];
  const nativeTools = getTierTools(input.catalogs, "native", input.tier);
  const gitnexusBase = getTierTools(input.catalogs, "gitnexus", GITNEXUS_BASE_TIER);
  const gitnexusExtras = input.tier === "MEDIUM" || input.tier === "HIGH" ? getTierTools(input.catalogs, "gitnexus", input.tier).filter((tool) => !gitnexusBase.includes(tool)) : [];
  const requestedGitnexusTools = uniqueOrdered([...gitnexusBase, ...gitnexusExtras]);
  const pythonKernelTools = getTierTools(input.catalogs, "python-kernel", input.tier);
  const pythonKernelState = input.extensionState?.["python-kernel"];
  const effectivePythonKernelState = resolveEffectiveExtensionState(pythonKernelState);
  const gitnexusState = input.specialistExclusions?.disabledExtensions?.includes("gitnexus") ? { ...input.extensionState?.gitnexus, enabled: false, health: "disabled" } : input.extensionState?.gitnexus;
  const effectiveGitnexusState = resolveEffectiveExtensionState(gitnexusState);
  const hardDenyAllowed = policy.denied_natives_mode === "hard" && effectiveGitnexusState.canEnforceHardDeny;
  const finalNativeTools = nativeTools.filter((tool) => {
    if (!hardDeniedTools.has(tool))
      return true;
    if (!hardDenyAllowed)
      return true;
    deniedNatives.push(tool);
    return false;
  });
  const toolsList = uniqueOrdered([
    ...finalNativeTools,
    ...effectiveGitnexusState.includeTools ? requestedGitnexusTools : [],
    ...effectivePythonKernelState.includeTools ? pythonKernelTools : []
  ]);
  if (!effectiveGitnexusState.includeTools && requestedGitnexusTools.length > 0) {
    warnings.push(`gitnexus tools excluded by extension state: ${effectiveGitnexusState.status}`);
  }
  if (!effectivePythonKernelState.includeTools && pythonKernelTools.length > 0) {
    warnings.push(`python-kernel tools excluded by extension state: ${effectivePythonKernelState.status}`);
  }
  if ((input.specialistExclusions?.disabledExtensions ?? []).length > 0) {
    warnings.push(`specialist exclusions: ${(input.specialistExclusions?.disabledExtensions ?? []).join(", ")}`);
    attribution.push({ layer: "specialist_exclusion", source: "specialist.json", tools: [] });
  }
  attribution.push({ layer: "catalog", source: "tool catalogs", tools: uniqueOrdered([...nativeTools, ...requestedGitnexusTools, ...pythonKernelTools]) });
  if (input.catalogDefaultOverrides?.[input.tier]) {
    attribution.push({
      layer: "catalog_default",
      source: "tool catalog defaults",
      tools: input.catalogDefaultOverrides[input.tier]?.denied_natives_when_extension ?? []
    });
  }
  if (input.manifestPolicy?.permissions?.[input.tier]) {
    attribution.push({
      layer: "tier_policy",
      source: "manifest policy",
      tools: input.manifestPolicy.permissions[input.tier]?.denied_natives_when_extension ?? []
    });
  }
  if (input.specialistOverride) {
    attribution.push({
      layer: "specialist_override",
      source: "specialist YAML",
      tools: input.specialistOverride.denied_natives_when_extension ?? []
    });
  }
  if (!hardDenyAllowed && policy.denied_natives_mode === "hard" && hardDeniedTools.size > 0) {
    const restoredNatives = nativeTools.filter((tool) => hardDeniedTools.has(tool));
    const reason = effectiveGitnexusState.status;
    warnings.push(`hard deny restored native fallback: ${reason}`);
    downgradeReasons.push(`restored native fallback for ${restoredNatives.join(",") || "(none)"} due to ${reason}`);
    attribution.push({ layer: "runtime_health", source: "fallback", tools: restoredNatives });
  }
  const preferenceSignals = policy.denied_natives_mode === "soft" && effectiveDenied.size > 0 ? [`soft deny prefers extension tools for: ${Array.from(effectiveDenied).join(",")}`] : [];
  return {
    tools: toolsList.join(","),
    toolsList,
    deniedNatives,
    deniedNativesMode: policy.denied_natives_mode ?? "soft",
    preferenceSignals,
    downgradeReasons,
    warnings,
    attribution
  };
}

// src/specialist/resolved-tool-contract.ts
function uniqueOrdered2(values) {
  const seen = new Set;
  const ordered = [];
  for (const value of values) {
    if (seen.has(value))
      continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}
function getCatalog2(catalogs, name) {
  return catalogs.find((catalog) => catalog.catalog === name);
}
function getRequestedExtensionTools(catalogs, name, tier) {
  const catalog = getCatalog2(catalogs, name);
  if (!catalog)
    return [];
  return uniqueOrdered2([
    ...catalog.source_tiers.READ_ONLY ?? [],
    ...catalog.source_tiers[tier] ?? []
  ]);
}
function getEffectiveExtensionStatus(input, name) {
  const state = input.specialistExclusions?.disabledExtensions?.includes(name) ? { ...input.extensionState?.[name], enabled: false, health: "disabled" } : input.extensionState?.[name];
  return resolveEffectiveExtensionState(state).status;
}
function formatList(values) {
  return values.length > 0 ? values.join(", ") : "(none)";
}
function buildResolvedToolContract(input) {
  const resolver = resolveManifestTools(input);
  const nativeCatalog = getCatalog2(input.catalogs, "native");
  const tierNativeTools = new Set(nativeCatalog?.source_tiers[input.tier] ?? []);
  const nativeTools = resolver.toolsList.filter((tool) => tierNativeTools.has(tool));
  const extensionTools = resolver.toolsList.filter((tool) => !tierNativeTools.has(tool));
  const exposedExtensionSources = uniqueOrdered2(input.extensionSources ?? []);
  const extensions = Object.fromEntries(input.catalogs.filter((catalog) => catalog.catalog !== "native").map((catalog) => {
    const activeTools = resolver.toolsList.filter((tool) => getRequestedExtensionTools(input.catalogs, catalog.catalog, input.tier).includes(tool));
    return [
      catalog.catalog,
      {
        status: getEffectiveExtensionStatus(input, catalog.catalog),
        packageName: input.extensionPackages?.[catalog.catalog]?.packageName,
        packagePath: input.extensionPackages?.[catalog.catalog]?.packagePath,
        activeTools
      }
    ];
  }));
  return {
    effectiveTier: input.tier,
    toolsFlag: resolver.tools,
    exposedExtensionSources,
    toolsList: resolver.toolsList,
    nativeTools,
    extensionTools,
    deniedNativeTools: resolver.deniedNatives,
    deniedNativesMode: resolver.deniedNativesMode,
    preferenceSignals: resolver.preferenceSignals,
    downgradeReasons: resolver.downgradeReasons,
    warnings: resolver.warnings,
    extensions
  };
}
function formatResolvedToolContract(contract) {
  const lines = [
    "## Resolved Tool Contract",
    `- effective tier: ${contract.effectiveTier}`,
    `- --tools: ${contract.toolsFlag || "(none)"}`,
    ...contract.exposedExtensionSources.length > 0 ? [`- exposed extension sources (all registered tools available via tool-policy gate): ${formatList(contract.exposedExtensionSources)}`] : [],
    `- actual native tools: ${formatList(contract.nativeTools)}`,
    `- active extension tools: ${formatList(contract.extensionTools)}`,
    `- denied native tools: ${formatList(contract.deniedNativeTools)}`,
    `- deny mode: ${contract.deniedNativesMode}`,
    "- extension state:"
  ];
  const extensionEntries = Object.entries(contract.extensions);
  if (extensionEntries.length === 0) {
    lines.push("  - (none)");
  } else {
    for (const [name, extension] of extensionEntries) {
      lines.push(`  - ${name}: ${extension.status}; active tools: ${formatList(extension.activeTools)}`);
    }
  }
  lines.push(`- preference signals: ${formatList(contract.preferenceSignals)}`);
  lines.push(`- downgrade reasons: ${formatList(contract.downgradeReasons)}`);
  lines.push(`- warnings: ${formatList(contract.warnings)}`);
  return lines.join(`
`);
}

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {};
  function assertIs(_arg) {}
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error;
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
class ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
}
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== undefined) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === en_default ? undefined : en_default
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}

class ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
}
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
class ParseInputLazyPath {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
}
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}

class ZodType {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus,
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(undefined).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
}
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}

class ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}

class ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
}
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = undefined;
    const status = new ParseStatus;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
}
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};

class ZodBoolean extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};

class ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus;
    let ctx = undefined;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
}
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};

class ZodSymbol extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};

class ZodUndefined extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};

class ZodNull extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};

class ZodAny extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};

class ZodUnknown extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
}
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};

class ZodNever extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
}
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};

class ZodVoid extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
}
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};

class ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : undefined,
          maximum: tooBig ? def.exactLength.value : undefined,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}

class ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {} else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== undefined ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  extend(augmentation) {
    return new ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  merge(merging) {
    const merged = new ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  catchall(index) {
    return new ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
}
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};

class ZodUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = undefined;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
}
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [undefined];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [undefined, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};

class ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(discriminator, options, params) {
    const optionsMap = new Map;
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
}
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}

class ZodIntersection extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
}
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};

class ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new ZodTuple({
      ...this._def,
      rest
    });
  }
}
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};

class ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
}

class ZodMap extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = new Map;
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = new Map;
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
}
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};

class ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = new Set;
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
}
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};

class ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
}

class ZodLazy extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
}
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};

class ZodLiteral extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
}
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}

class ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
}
ZodEnum.create = createZodEnum;

class ZodNativeEnum extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
}
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};

class ZodPromise extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
}
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};

class ZodEffects extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
}
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
class ZodOptional extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(undefined);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};

class ZodNullable extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};

class ZodDefault extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
}
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};

class ZodCatch extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
}
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};

class ZodNaN extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
}
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");

class ZodBranded extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
}

class ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
}

class ZodReadonly extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
}
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;

// src/specialist/tool-catalog.ts
var TierSchema = enumType(["READ_ONLY", "LOW", "MEDIUM", "HIGH"]);
var LayerSchema = enumType(["native", "gitnexus", "python-kernel", "service-knowledge"]);
var ToolTierMapSchema = recordType(TierSchema, arrayType(stringType()));
var ToolCatalogSchema = objectType({
  catalog: LayerSchema,
  package: stringType(),
  version: stringType(),
  precedence: numberType().int().nonnegative(),
  source_tiers: ToolTierMapSchema
}).passthrough();
var ManifestPolicyTierSchema = objectType({
  denied_natives_when_extension: arrayType(stringType()).optional(),
  denied_natives_mode: enumType(["soft", "hard"]).optional()
}).passthrough();
var ToolCatalogIndexSchema = objectType({
  precedence_order: arrayType(LayerSchema),
  default_overrides: recordType(TierSchema, ManifestPolicyTierSchema).optional(),
  catalogs: arrayType(ToolCatalogSchema)
}).passthrough();
function validateToolCatalogIndex(value) {
  return ToolCatalogIndexSchema.parse(value);
}
function loadToolCatalogIndex(jsonText) {
  return validateToolCatalogIndex(JSON.parse(jsonText));
}

// src/pi/session.ts
class SessionKilledError extends Error {
  constructor() {
    super("Session was killed");
    this.name = "SessionKilledError";
  }
}

class StallTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Session stalled: no activity for ${timeoutMs}ms`);
    this.name = "StallTimeoutError";
  }
}
var TEST_COMMAND_STALL_TIMEOUT_MS = 300000;
var GITNEXUS_IMPACT_STALL_TIMEOUT_MS = 300000;
var TEST_COMMAND_PATTERNS = [
  /(?:^|\s)(?:bun\s+--bun\s+)?vitest(?:\s|$)/i,
  /(?:^|\s)bun\s+test(?:\s|$)/i,
  /(?:^|\s)npm\s+test(?:\s|$)/i,
  /(?:^|\s)(?:pnpm|yarn)\s+test(?:\s|$)/i,
  /(?:^|\s)(?:node\s+)?jest(?:\s|$)/i,
  /(?:^|\s)pytest(?:\s|$)/i
];
var RUNTIME_TOOL_CATALOG_ERROR_MESSAGE = "Runtime tool catalog unavailable or invalid; refusing to launch with Pi default tools. Reinstall or rebuild Specialists and verify config/catalog/index.json.";

class RuntimeToolCatalogResolutionError extends Error {
  reason;
  code = "runtime_tool_catalog_unavailable";
  constructor(reason) {
    super(RUNTIME_TOOL_CATALOG_ERROR_MESSAGE);
    this.reason = reason;
    this.name = "RuntimeToolCatalogResolutionError";
  }
}
function toRuntimeToolCatalogs(catalogIndex) {
  return catalogIndex.catalogs.map((catalog) => ({
    catalog: catalog.catalog,
    precedence: catalog.precedence,
    source_tiers: {
      READ_ONLY: catalog.source_tiers.READ_ONLY ?? [],
      LOW: catalog.source_tiers.LOW ?? [],
      MEDIUM: catalog.source_tiers.MEDIUM ?? [],
      HIGH: catalog.source_tiers.HIGH ?? []
    }
  }));
}
function loadSharedToolCatalogIndex(cwd) {
  const overridePath = resolve4(cwd, ".specialists", "catalog", "index.json");
  let overrideExists = false;
  try {
    lstatSync(overridePath);
    overrideExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new RuntimeToolCatalogResolutionError("project_catalog_invalid");
    }
  }
  if (overrideExists) {
    try {
      return loadToolCatalogIndex(readFileSync(overridePath, "utf8"));
    } catch {
      throw new RuntimeToolCatalogResolutionError("project_catalog_invalid");
    }
  }
  let canonicalDir;
  try {
    canonicalDir = resolveCanonicalAssetDir("catalog");
  } catch {
    throw new RuntimeToolCatalogResolutionError("canonical_catalog_unavailable");
  }
  if (!canonicalDir) {
    throw new RuntimeToolCatalogResolutionError("canonical_catalog_unavailable");
  }
  const canonicalPath = resolve4(canonicalDir, "index.json");
  try {
    return loadToolCatalogIndex(readFileSync(canonicalPath, "utf8"));
  } catch {
    throw new RuntimeToolCatalogResolutionError("canonical_catalog_invalid");
  }
}
function readPackageVersion(packageJsonPath) {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return;
  }
}
function resolveGitnexusRuntime(options) {
  const gitnexusCatalog = options.catalogIndex.catalogs.find((catalog) => catalog.catalog === "gitnexus");
  const packageName = gitnexusCatalog?.package ?? "pi-gitnexus";
  if ((options.excludeExtensions ?? []).includes(packageName)) {
    return {
      packageName,
      extensionState: { enabled: false, health: "disabled", catalogCompatible: true }
    };
  }
  const globalDir = resolveGlobalNodeModulesDir2();
  if (!globalDir) {
    return {
      packageName,
      extensionState: { enabled: true, health: "not_installed", catalogCompatible: false }
    };
  }
  const packagePath = join4(globalDir, packageName);
  const packageJsonPath = join4(packagePath, "package.json");
  if (!existsSync5(packageJsonPath)) {
    return {
      packageName,
      extensionState: { enabled: true, health: "not_installed", catalogCompatible: false }
    };
  }
  const installedVersion = readPackageVersion(packageJsonPath);
  if (!installedVersion) {
    return {
      packageName,
      packagePath,
      extensionState: { enabled: true, health: "loaded_unhealthy", catalogCompatible: false }
    };
  }
  if (gitnexusCatalog && installedVersion !== gitnexusCatalog.version) {
    return {
      packageName,
      packagePath,
      extensionState: { enabled: true, health: "loaded_unhealthy", catalogCompatible: false }
    };
  }
  return {
    packageName,
    packagePath,
    extensionState: { enabled: true, health: "loaded_healthy", catalogCompatible: true }
  };
}
function resolvePiExtensionsPythonKernelRuntime(options) {
  const catalog = options.catalogIndex.catalogs.find((c) => c.catalog === "python-kernel");
  const packageName = catalog?.package ?? "@jaggerxtrm/pi-extensions";
  if ((options.excludeExtensions ?? []).includes(packageName)) {
    return {
      packageName,
      extensionState: { enabled: false, health: "disabled", catalogCompatible: true }
    };
  }
  const globalDir = resolveGlobalNodeModulesDir2();
  if (!globalDir) {
    return {
      packageName,
      extensionState: { enabled: true, health: "not_installed", catalogCompatible: false }
    };
  }
  const packagePath = join4(globalDir, packageName);
  const packageJsonPath = join4(packagePath, "package.json");
  if (!existsSync5(packageJsonPath)) {
    return {
      packageName,
      extensionState: { enabled: true, health: "not_installed", catalogCompatible: false }
    };
  }
  const installedVersion = readPackageVersion(packageJsonPath);
  const extPath = join4(packagePath, "extensions", "python-kernel", "index.ts");
  if (!installedVersion || !existsSync5(extPath)) {
    return {
      packageName,
      packagePath,
      extensionState: { enabled: true, health: "loaded_unhealthy", catalogCompatible: false }
    };
  }
  if (catalog && installedVersion !== catalog.version) {
    return {
      packageName,
      packagePath,
      extensionState: { enabled: true, health: "loaded_unhealthy", catalogCompatible: false }
    };
  }
  return {
    packageName,
    packagePath,
    extensionState: { enabled: true, health: "loaded_healthy", catalogCompatible: true }
  };
}
function resolveRuntimeToolContract(options) {
  if (options.level === undefined)
    return;
  const tier = options.level.trim().toUpperCase();
  if (tier !== "READ_ONLY" && tier !== "LOW" && tier !== "MEDIUM" && tier !== "HIGH") {
    throw new RuntimeToolCatalogResolutionError("invalid_permission_tier");
  }
  const catalogIndex = loadSharedToolCatalogIndex(resolve4(options.cwd ?? process.cwd()));
  const specialistOverride = options.specialistPermissions?.[tier];
  const gitnexusRuntime = resolveGitnexusRuntime({
    catalogIndex,
    excludeExtensions: options.excludeExtensions
  });
  const pythonKernelRuntime = resolvePiExtensionsPythonKernelRuntime({
    catalogIndex,
    excludeExtensions: options.excludeExtensions
  });
  const runtimeCatalogs = toRuntimeToolCatalogs(catalogIndex);
  let contract;
  try {
    contract = buildResolvedToolContract({
      tier,
      catalogs: runtimeCatalogs,
      catalogDefaultOverrides: catalogIndex.default_overrides,
      manifestPolicy: options.specialistPermissions ? { permissions: options.specialistPermissions } : undefined,
      specialistOverride,
      specialistExclusions: (options.excludeExtensions ?? []).includes(gitnexusRuntime.packageName) ? { disabledExtensions: ["gitnexus"] } : undefined,
      extensionSources: options.extensionSources,
      extensionState: {
        gitnexus: gitnexusRuntime.extensionState,
        "python-kernel": pythonKernelRuntime.extensionState
      },
      extensionPackages: {
        gitnexus: {
          packageName: gitnexusRuntime.packageName,
          packagePath: gitnexusRuntime.packagePath
        },
        "python-kernel": {
          packageName: pythonKernelRuntime.packageName,
          packagePath: pythonKernelRuntime.packagePath
        }
      }
    });
  } catch {
    throw new RuntimeToolCatalogResolutionError("tool_contract_invalid");
  }
  if (!contract.toolsFlag.trim()) {
    throw new RuntimeToolCatalogResolutionError("empty_tool_contract");
  }
  return contract;
}
function applyExtensionToolPolicyGate(args, contract, env) {
  if (!contract || (contract.exposedExtensionSources?.length ?? 0) === 0)
    return;
  const policyPath = getExtensionToolPolicyExtensionPath();
  if (!policyPath) {
    throw new Error("[xtrm-tool-policy] bundled policy extension not found while extension sources are enabled " + `(${contract.exposedExtensionSources.join(", ")}); aborting launch. ` + "Reinstall or rebuild the specialists package so config/pi-extensions/extension-tool-policy ships.");
  }
  args.push("--no-builtin-tools");
  args.push("-e", policyPath);
  env[NATIVE_TOOLS_ENV_KEY] = contract.nativeTools.join(",");
}
function isRemoteExtensionSource(source) {
  return source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("http://") || source.startsWith("https://");
}
function resolveExecutionExtensionSelection(extensions) {
  const excludeExtensions = [];
  const extensionSources = [];
  for (const [source, enabled] of Object.entries(extensions ?? {})) {
    if (source === "serena")
      continue;
    if (source === "gitnexus") {
      if (enabled === false)
        excludeExtensions.push("pi-gitnexus");
      continue;
    }
    if (enabled !== true)
      continue;
    extensionSources.push(source);
  }
  return {
    excludeExtensions,
    extensionSources,
    offline: !extensionSources.some(isRemoteExtensionSource)
  };
}
function resolveGlobalNodeModulesDir2() {
  const candidates = [
    process.env.PI_NPM_GLOBAL_DIR,
    process.env.NPM_CONFIG_PREFIX ? join4(process.env.NPM_CONFIG_PREFIX, "lib", "node_modules") : undefined,
    process.env.npm_config_prefix ? join4(process.env.npm_config_prefix, "lib", "node_modules") : undefined,
    process.env.NVM_BIN ? join4(dirname4(process.env.NVM_BIN), "lib", "node_modules") : undefined,
    join4(homedir2(), ".nvm/versions/node", process.version, "lib", "node_modules")
  ].filter((candidate) => Boolean(candidate));
  return candidates.find((candidate) => existsSync5(candidate));
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return;
}
function normalizeUsageSource(value) {
  if (value === "provider_usage" || value === "runtime_estimate" || value === "local_estimate" || value === "unknown")
    return value;
  return "unknown";
}
function pickFirstNumber(record, keys) {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined)
      return value;
  }
  return;
}
function normalizeTokenUsage(candidate) {
  if (!candidate || typeof candidate !== "object")
    return;
  const usage = candidate;
  const normalized = {
    input_tokens: pickFirstNumber(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"]),
    output_tokens: pickFirstNumber(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output"]),
    cache_creation_tokens: pickFirstNumber(usage, ["cache_creation_tokens", "cacheCreationTokens", "cache_write_tokens", "cacheWrite"]),
    cache_read_tokens: pickFirstNumber(usage, ["cache_read_tokens", "cacheReadTokens", "cache_hit_tokens", "cacheRead"]),
    reasoning_tokens: pickFirstNumber(usage, ["reasoning_tokens", "reasoningTokens", "thinking_tokens", "thinkingTokens"]),
    tool_tokens: pickFirstNumber(usage, ["tool_tokens", "toolTokens", "tool_use_tokens", "toolUseTokens"]),
    total_tokens: pickFirstNumber(usage, ["total_tokens", "totalTokens"]),
    usage_source: typeof usage.usage_source === "string" ? normalizeUsageSource(usage.usage_source) : "provider_usage"
  };
  const hasAny = Object.values(normalized).some((value) => value !== undefined);
  if (!hasAny)
    return;
  if (normalized.total_tokens === undefined) {
    const components = [
      normalized.input_tokens,
      normalized.output_tokens,
      normalized.cache_creation_tokens,
      normalized.cache_read_tokens
    ].filter((value) => value !== undefined);
    if (components.length > 0) {
      normalized.total_tokens = components.reduce((sum, value) => sum + value, 0);
    }
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}
function findFinishReason(payload) {
  if (!payload || typeof payload !== "object")
    return;
  const record = payload;
  const direct = record.stopReason ?? record.finishReason ?? record.finish_reason ?? record.reason;
  if (typeof direct === "string" && direct.trim().length > 0)
    return direct;
  return;
}
function findTokenUsage(payload) {
  if (!payload || typeof payload !== "object")
    return;
  const record = payload;
  const message = record.message && typeof record.message === "object" ? record.message : undefined;
  const assistantMessage = Array.isArray(record.messages) ? [...record.messages].reverse().find((m) => !!m && typeof m === "object" && m.role === "assistant") : undefined;
  const candidates = [
    record.usage,
    record.tokenUsage,
    record.token_usage,
    message?.usage,
    message?.tokenUsage,
    message?.token_usage,
    assistantMessage?.usage,
    assistantMessage?.tokenUsage,
    assistantMessage?.token_usage,
    record.stats?.usage,
    record.stats?.tokenUsage,
    record.result?.usage,
    record.result?.tokenUsage,
    record.assistantMessageEvent?.usage,
    record.assistantMessageEvent?.tokenUsage
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTokenUsage(candidate);
    if (normalized)
      return normalized;
  }
  return normalizeTokenUsage(record);
}
function extractMessageTextContent(message) {
  if (!message || typeof message !== "object")
    return "";
  const record = message;
  const content = record.content;
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.map((part) => {
    if (!part || typeof part !== "object")
      return "";
    const item = part;
    if (item.type !== undefined && item.type !== "text")
      return "";
    return typeof item.text === "string" ? item.text : "";
  }).join("");
}
function findApiErrorMessage(payload) {
  if (!payload || typeof payload !== "object")
    return;
  const record = payload;
  const direct = [record.errorMessage, record.error_message, record.error, record.message].find((value) => typeof value === "string" && value.trim().length > 0);
  if (typeof direct === "string")
    return direct.trim();
  const nestedError = record.error;
  if (nestedError && typeof nestedError === "object") {
    const nested = nestedError;
    const nestedMessage = [nested.message, nested.errorMessage, nested.error_message].find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof nestedMessage === "string")
      return nestedMessage.trim();
  }
  const message = record.assistantMessageEvent;
  if (message && typeof message === "object") {
    const nested = message;
    const nestedMessage = [nested.errorMessage, nested.error_message, nested.error, nested.message].find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof nestedMessage === "string")
      return nestedMessage.trim();
  }
  return;
}
function extractApiErrorFromStderr(stderr) {
  const compact = stderr.trim();
  if (!compact)
    return;
  const patterns = [
    /You have hit your ChatGPT usage limit[^\n]*/i,
    /rate limit[^\n]*/i,
    /quota[^\n]*/i,
    /auth(?:entication)?[^\n]*/i,
    /unauthori[sz]ed[^\n]*/i,
    /forbidden[^\n]*/i,
    /overloaded[^\n]*/i
  ];
  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (match)
      return match[0].trim();
  }
  return;
}
function normalizeToolResultPart(contentPart) {
  if (!contentPart || typeof contentPart !== "object")
    return;
  const part = contentPart;
  const text = part.text;
  if (typeof text === "string" && text.trim().length > 0)
    return text;
  const content = part.content;
  if (typeof content === "string" && content.trim().length > 0)
    return content;
  const output = part.output;
  if (typeof output === "string" && output.trim().length > 0)
    return output;
  return;
}
function findToolResultContent(payload) {
  if (!payload || typeof payload !== "object")
    return;
  const record = payload;
  const result = record.result;
  if (!result || typeof result !== "object")
    return;
  const resultRecord = result;
  const content = resultRecord.content;
  if (Array.isArray(content)) {
    const parts = content.map(normalizeToolResultPart).filter((value) => typeof value === "string" && value.length > 0);
    if (parts.length > 0)
      return parts.join(`
`);
  }
  if (typeof resultRecord.content === "string" && resultRecord.content.trim().length > 0) {
    return resultRecord.content;
  }
  if (typeof resultRecord.output === "string" && resultRecord.output.trim().length > 0) {
    return resultRecord.output;
  }
  return;
}
function findToolResultRaw(payload) {
  if (!payload || typeof payload !== "object")
    return;
  const record = payload;
  const result = record.result;
  if (!result || typeof result !== "object" || Array.isArray(result))
    return;
  return result;
}
function findStringValue(payload, keys) {
  if (!payload || typeof payload !== "object")
    return;
  const record = payload;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0)
      return value;
  }
  return;
}
function extractBashCommand(args) {
  if (!args)
    return;
  const command = args.command ?? args.cmd ?? args.script;
  if (typeof command !== "string")
    return;
  const normalizedCommand = command.trim();
  return normalizedCommand.length > 0 ? normalizedCommand : undefined;
}
function isTestCommand(command) {
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}
var WRITE_BOUNDARY_TOOL_NAMES = new Set(["edit", "write", "multiEdit", "notebookEdit"]);
var WORKTREE_BOUNDARY_ENV_KEY = "SPECIALISTS_WORKTREE_BOUNDARY";
function getWorktreeBoundaryExtensionPath(worktreeBoundary) {
  const boundaryHash = createHash("sha256").update(resolve4(worktreeBoundary)).digest("hex").slice(0, 16);
  const extensionsDir = join4(tmpdir(), "specialists-pi-extensions");
  try {
    mkdirSync(extensionsDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`[worktree-boundary] WARN: could not create extensions directory at ${extensionsDir}: ${err.message}. ` + `Boundary enforcement will NOT apply for this session.
`);
    return null;
  }
  const extensionPath = join4(extensionsDir, `worktree-boundary-${boundaryHash}.mjs`);
  if (existsSync5(extensionPath))
    return extensionPath;
  const extensionSource = `
import { isAbsolute, resolve } from 'node:path';

const WRITE_TOOLS = new Set(['edit', 'write', 'multiEdit', 'notebookEdit']);
const WORKTREE_BOUNDARY_ENV_KEY = '${WORKTREE_BOUNDARY_ENV_KEY}';

function isPathWithinBoundary(path, boundary) {
  const resolvedPath = resolve(path);
  const resolvedBoundary = resolve(boundary);
  if (resolvedPath === resolvedBoundary) return true;
  return resolvedPath.startsWith(resolvedBoundary.endsWith('/') ? resolvedBoundary : resolvedBoundary + '/');
}

export default function(pi) {
  const worktreeBoundary = process.env[WORKTREE_BOUNDARY_ENV_KEY];
  if (!worktreeBoundary) return;

  pi.on('tool_call', (event) => {
    if (!WRITE_TOOLS.has(event.toolName)) return undefined;

    const input = event.input && typeof event.input === 'object' ? event.input : {};
    const rawPath = typeof input.path === 'string'
      ? input.path
      : (typeof input.file_path === 'string' ? input.file_path : undefined);

    if (!rawPath || !isAbsolute(rawPath)) return undefined;

    if (isPathWithinBoundary(rawPath, worktreeBoundary)) return undefined;

    return {
      block: true,
      reason: \`Path '\${rawPath}' is outside worktree boundary ('\${resolve(worktreeBoundary)}'). Use a relative path or a path within the worktree.\`,
    };
  });
}
`.trimStart();
  try {
    writeFileSync(extensionPath, extensionSource, "utf-8");
  } catch (err) {
    process.stderr.write(`[worktree-boundary] WARN: could not write extension file at ${extensionPath}: ${err.message}. ` + `Boundary enforcement will NOT apply for this session.
`);
    return null;
  }
  return extensionPath;
}

class PiAgentSession {
  options;
  proc;
  _lastOutput = "";
  _donePromise;
  _doneResolve;
  _doneReject;
  _agentEndReceived = false;
  _killed = false;
  _lineBuffer = "";
  _pendingRequests = new Map;
  _nextRequestId = 1;
  _stderrBuffer = "";
  _apiError;
  _stallTimer;
  _stallError;
  _testWindowToolCallIds = new Set;
  _testWindowWithoutIdCount = 0;
  _impactWindowToolCallIds = new Set;
  _impactWindowWithoutIdCount = 0;
  _metrics = {
    turns: 0,
    tool_calls: 0,
    auto_compactions: 0,
    auto_retries: 0
  };
  meta;
  constructor(options, meta) {
    this.options = options;
    this.meta = meta;
  }
  static async create(options) {
    const meta = {
      backend: options.model.includes("/") ? options.model.split("/")[0] : mapSpecialistBackend(options.model),
      model: options.model,
      sessionId: crypto.randomUUID(),
      startedAt: new Date
    };
    return new PiAgentSession(options, meta);
  }
  async start() {
    const model = this.options.model;
    const extraArgs = getProviderArgs(model);
    const providerArgs = model.includes("/") ? ["--model", model] : ["--provider", mapSpecialistBackend(model)];
    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      ...providerArgs,
      "--no-session",
      ...this.options.offline === false ? [] : ["--offline"],
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
      ...extraArgs
    ];
    const resolvedToolContract = this.options.resolvedToolContract ?? resolveRuntimeToolContract({
      level: this.options.permissionLevel,
      specialistName: this.options.specialistName,
      specialistPermissions: this.options.specialistPermissions,
      excludeExtensions: this.options.excludeExtensions,
      extensionSources: this.options.extensionSources,
      cwd: this.options.cwd
    });
    if (this.options.permissionLevel !== undefined && !resolvedToolContract?.toolsFlag.trim()) {
      throw new RuntimeToolCatalogResolutionError("empty_tool_contract");
    }
    if (resolvedToolContract?.toolsFlag && (resolvedToolContract.exposedExtensionSources?.length ?? 0) === 0) {
      args.push("--tools", resolvedToolContract.toolsFlag);
    }
    if (this.options.thinkingLevel) {
      args.push("--thinking", this.options.thinkingLevel);
    }
    for (const skillPath of this.options.skillPaths ?? []) {
      args.push("--skill", skillPath);
    }
    const piExtDir = join4(homedir2(), ".pi", "agent", "extensions");
    const permLevel = (this.options.permissionLevel ?? "").toUpperCase();
    if (permLevel !== "READ_ONLY") {
      const qgPath = join4(piExtDir, "quality-gates");
      if (existsSync5(qgPath))
        args.push("-e", qgPath);
    }
    const pyKernelPath = resolvePiExtensionsPythonKernelPath();
    if (pyKernelPath && permLevel !== "READ_ONLY") {
      args.push("-e", pyKernelPath);
    }
    const cavemanPath = join4(piExtDir, "caveman");
    if (existsSync5(cavemanPath))
      args.push("-e", cavemanPath);
    const nvidiaNimPath = join4(homedir2(), ".pi", "agent", "git", "github.com", "xRyul", "pi-nvidia-nim");
    if (existsSync5(nvidiaNimPath))
      args.push("-e", nvidiaNimPath);
    const gitnexusContract = resolvedToolContract?.extensions.gitnexus;
    if (gitnexusContract?.status === "available" && gitnexusContract.packagePath && existsSync5(gitnexusContract.packagePath)) {
      args.push("-e", gitnexusContract.packagePath);
    }
    for (const source of this.options.extensionSources ?? []) {
      args.push("-e", source);
    }
    if (this.options.systemPrompt) {
      const systemPromptFlag = this.options.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
      args.push(systemPromptFlag, this.options.systemPrompt);
    }
    const worktreeBoundary = this.options.worktreeBoundary ? resolve4(this.options.worktreeBoundary) : undefined;
    if (worktreeBoundary) {
      const boundaryExtPath = getWorktreeBoundaryExtensionPath(worktreeBoundary);
      if (boundaryExtPath) {
        args.push("-e", boundaryExtPath);
      }
    }
    const readLineNumbersPath = getReadLineNumbersExtensionPath();
    if (readLineNumbersPath)
      args.push("-e", readLineNumbersPath);
    const policyEnv = {};
    applyExtensionToolPolicyGate(args, resolvedToolContract, policyEnv);
    const hookEnv = {
      ...process.env,
      ...this.options.env ?? {},
      ...policyEnv,
      CAVEMAN_LEVEL: "full",
      PI_KERNEL_AUDIT_POLICY: "1"
    };
    const sessionCwd = resolve4(this.options.cwd ?? process.cwd());
    this.proc = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: sessionCwd,
      env: worktreeBoundary ? { ...hookEnv, [WORKTREE_BOUNDARY_ENV_KEY]: worktreeBoundary } : hookEnv,
      detached: true
    });
    const donePromise = new Promise((resolve5, reject) => {
      this._doneResolve = resolve5;
      this._doneReject = reject;
    });
    donePromise.catch(() => {});
    this._donePromise = donePromise;
    this.proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      this._stderrBuffer += text;
      this._apiError ??= extractApiErrorFromStderr(this._stderrBuffer) ?? extractApiErrorFromStderr(text);
    });
    this.proc.stdout?.on("data", (chunk) => {
      this._lineBuffer += chunk.toString();
      const lines = this._lineBuffer.split(`
`);
      this._lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim())
          this._handleEvent(line);
      }
    });
    this.proc.stdout?.on("end", () => {
      if (this._lineBuffer.trim()) {
        this._handleEvent(this._lineBuffer);
        this._lineBuffer = "";
      }
    });
    this.proc.on("close", (code) => {
      this._clearStallTimer();
      if (this._pendingRequests.size > 0) {
        const stderrTail = this._stderrBuffer.trim().split(`
`).slice(-5).join(`
`).slice(0, 2000);
        const exitDetail = code === null ? "" : ` with code ${code}`;
        const message = `pi process exited${exitDetail} before responding to RPC command${stderrTail ? `; stderr:
${stderrTail}` : ""}`;
        for (const [, entry] of this._pendingRequests) {
          clearTimeout(entry.timer);
          entry.reject(new Error(message));
        }
        this._pendingRequests.clear();
      }
      if (this._agentEndReceived || this._killed) {
        this._doneResolve?.();
      } else if (code === 0 || code === null) {
        this._doneResolve?.();
      } else {
        this._doneReject?.(new Error(`pi process exited with code ${code}`));
      }
    });
  }
  _clearStallTimer() {
    if (this._stallTimer) {
      clearTimeout(this._stallTimer);
      this._stallTimer = undefined;
    }
  }
  _isTestWindowActive() {
    return this._testWindowToolCallIds.size > 0 || this._testWindowWithoutIdCount > 0;
  }
  _isImpactWindowActive() {
    return this._impactWindowToolCallIds.size > 0 || this._impactWindowWithoutIdCount > 0;
  }
  _resolveStallTimeoutMs() {
    const baseTimeoutMs = this.options.stallTimeoutMs;
    if (!baseTimeoutMs || baseTimeoutMs <= 0)
      return;
    let timeoutMs = baseTimeoutMs;
    if (this._isTestWindowActive()) {
      const testCommandTimeoutMs = this.options.testCommandStallTimeoutMs ?? TEST_COMMAND_STALL_TIMEOUT_MS;
      timeoutMs = Math.max(timeoutMs, testCommandTimeoutMs);
    }
    if (this._isImpactWindowActive()) {
      timeoutMs = Math.max(timeoutMs, GITNEXUS_IMPACT_STALL_TIMEOUT_MS);
    }
    return timeoutMs;
  }
  _activateTestWindow(toolCallId) {
    if (toolCallId) {
      this._testWindowToolCallIds.add(toolCallId);
      return;
    }
    this._testWindowWithoutIdCount += 1;
  }
  _deactivateTestWindow(toolCallId) {
    if (toolCallId) {
      this._testWindowToolCallIds.delete(toolCallId);
      return;
    }
    if (this._testWindowWithoutIdCount > 0) {
      this._testWindowWithoutIdCount -= 1;
    }
  }
  _activateImpactWindow(toolCallId) {
    if (toolCallId) {
      this._impactWindowToolCallIds.add(toolCallId);
      return;
    }
    this._impactWindowWithoutIdCount += 1;
  }
  _deactivateImpactWindow(toolCallId) {
    if (toolCallId) {
      this._impactWindowToolCallIds.delete(toolCallId);
      return;
    }
    if (this._impactWindowWithoutIdCount > 0) {
      this._impactWindowWithoutIdCount -= 1;
    }
  }
  _markActivity() {
    const timeoutMs = this._resolveStallTimeoutMs();
    if (!timeoutMs || this._killed || this._agentEndReceived)
      return;
    this._clearStallTimer();
    this._stallTimer = setTimeout(() => {
      if (this._killed || this._agentEndReceived)
        return;
      const err = new StallTimeoutError(timeoutMs);
      this._stallError = err;
      this.kill(err);
    }, timeoutMs);
  }
  _updateTokenUsage(tokenUsage, source) {
    if (!tokenUsage)
      return;
    this._metrics.token_usage = {
      ...this._metrics.token_usage,
      ...tokenUsage
    };
    this.options.onMetric?.({ type: "token_usage", token_usage: tokenUsage, source });
  }
  _updateFinishReason(finishReason, source) {
    if (!finishReason)
      return;
    this._metrics.finish_reason = finishReason;
    this.options.onMetric?.({ type: "finish_reason", finish_reason: finishReason, source });
  }
  _handleEvent(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this._markActivity();
    const { type } = event;
    if (type === "response") {
      const id = event.id;
      if (id !== undefined) {
        const entry = this._pendingRequests.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this._pendingRequests.delete(id);
          entry.resolve(event);
        }
      }
      return;
    }
    if (type === "message_start") {
      const role = event.message?.role;
      if (role === "assistant") {
        this.options.onEvent?.("message_start_assistant");
        const { provider, model } = event.message ?? {};
        if (provider || model) {
          this.options.onMeta?.({ backend: provider ?? "", model: model ?? "", sessionId: this.meta.sessionId });
        }
      } else if (role === "toolResult") {
        this.options.onEvent?.("message_start_tool_result");
      }
      return;
    }
    if (type === "message_end") {
      const role = event.message?.role;
      if (role === "assistant") {
        const content = extractMessageTextContent(event.message);
        this.options.onEvent?.("message_end_assistant", content ? { content, charCount: content.length } : undefined);
      } else if (role === "toolResult") {
        this.options.onEvent?.("message_end_tool_result");
      }
      return;
    }
    if (type === "turn_start") {
      this._metrics.turns = (this._metrics.turns ?? 0) + 1;
      this.options.onEvent?.("turn_start");
      return;
    }
    if (type === "turn_end") {
      const tokenUsage = findTokenUsage(event);
      const finishReason = findFinishReason(event);
      this._updateTokenUsage(tokenUsage, "turn_end");
      this._updateFinishReason(finishReason, "turn_end");
      this.options.onMetric?.({
        type: "turn_summary",
        turn_index: this._metrics.turns ?? 0,
        ...tokenUsage ? { token_usage: tokenUsage } : {},
        ...finishReason ? { finish_reason: finishReason } : {}
      });
      this.options.onEvent?.("turn_end");
      return;
    }
    if (type === "agent_end") {
      const messages = event.messages ?? [];
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      if (last) {
        this._lastOutput = extractMessageTextContent(last);
      }
      this._updateTokenUsage(findTokenUsage(event), "agent_end");
      this._updateFinishReason(findFinishReason(event), "agent_end");
      const apiError = findApiErrorMessage(event) ?? this._apiError ?? extractApiErrorFromStderr(this._stderrBuffer);
      if (apiError) {
        this._apiError = apiError;
        this._metrics.api_error = apiError;
        this.options.onMetric?.({ type: "api_error", source: "stderr", errorMessage: apiError });
      }
      this._agentEndReceived = true;
      this._clearStallTimer();
      if (this._lastOutput) {
        this.options.onEvent?.("agent_end", { content: this._lastOutput, charCount: this._lastOutput.length });
      } else {
        this.options.onEvent?.("agent_end");
      }
      this._doneResolve?.();
      return;
    }
    if (type === "tool_execution_start") {
      this._metrics.tool_calls = (this._metrics.tool_calls ?? 0) + 1;
      const toolName = event.toolName ?? event.name ?? "tool";
      const toolArgs = event.args;
      const toolCallId = event.toolCallId;
      const command = toolName === "bash" ? extractBashCommand(toolArgs) : undefined;
      if (command && isTestCommand(command)) {
        this._activateTestWindow(toolCallId);
        this._markActivity();
      }
      if (toolName === "gitnexus_impact") {
        this._activateImpactWindow(toolCallId);
        this._markActivity();
      }
      this.options.onToolStart?.(toolName, toolArgs, toolCallId);
      this.options.onEvent?.("tool_execution_start", { toolCallId });
      return;
    }
    if (type === "tool_execution_update") {
      this.options.onEvent?.("tool_execution_update", { toolCallId: event.toolCallId });
      return;
    }
    if (type === "tool_execution_end") {
      const toolName = event.toolName ?? event.name ?? "tool";
      const toolCallId = event.toolCallId;
      this.options.onToolEnd?.(toolName, event.isError ?? false, toolCallId, findToolResultContent(event), findToolResultRaw(event));
      if (toolName === "bash") {
        this._deactivateTestWindow(toolCallId);
        this._markActivity();
      }
      if (toolName === "gitnexus_impact") {
        this._deactivateImpactWindow(toolCallId);
        this._markActivity();
      }
      this.options.onEvent?.("tool_execution_end", { toolCallId });
      return;
    }
    if (type === "auto_compaction_start" || type === "auto_compaction_end") {
      if (type === "auto_compaction_end") {
        this._metrics.auto_compactions = (this._metrics.auto_compactions ?? 0) + 1;
      }
      const compactionDetails = {
        tokensBefore: asNumber(event.tokensBefore ?? event.tokens_before),
        summary: findStringValue(event, ["summary"]),
        firstKeptEntryId: findStringValue(event, ["firstKeptEntryId", "first_kept_entry_id"])
      };
      this.options.onMetric?.({
        type: "compaction",
        phase: type === "auto_compaction_start" ? "start" : "end",
        ...compactionDetails
      });
      this.options.onEvent?.(type, compactionDetails);
      return;
    }
    if (type === "auto_retry_start" || type === "auto_retry_end") {
      if (type === "auto_retry_end") {
        this._metrics.auto_retries = (this._metrics.auto_retries ?? 0) + 1;
      }
      const retryDetails = {
        attempt: asNumber(event.attempt),
        maxAttempts: asNumber(event.maxAttempts ?? event.max_attempts),
        delayMs: asNumber(event.delayMs ?? event.delay_ms),
        errorMessage: findStringValue(event, ["errorMessage", "error_message", "error"])
      };
      this.options.onMetric?.({
        type: "retry",
        phase: type === "auto_retry_start" ? "start" : "end",
        ...retryDetails
      });
      this.options.onEvent?.(type, retryDetails);
      return;
    }
    if (type === "set_model" || type === "cycle_model") {
      const modelChange = {
        action: type,
        model: findStringValue(event, ["model", "newModel", "new_model"]),
        previousModel: findStringValue(event, ["previousModel", "previous_model", "oldModel", "old_model"])
      };
      this.options.onMetric?.({ type: "model_change", ...modelChange });
      this.options.onEvent?.(type, modelChange);
      return;
    }
    if (type === "extension_error") {
      const extensionError = {
        extension: findStringValue(event, ["extension", "extensionName", "name"]),
        errorMessage: findStringValue(event, ["errorMessage", "error_message", "error"])
      };
      this.options.onMetric?.({ type: "extension_error", ...extensionError });
      this.options.onEvent?.("extension_error", extensionError);
      return;
    }
    if (type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (!ae)
        return;
      switch (ae.type) {
        case "text_delta": {
          const delta = typeof ae.delta === "string" ? ae.delta : "";
          if (delta)
            this.options.onToken?.(delta);
          this.options.onEvent?.("text", { charCount: delta.length, content: delta });
          break;
        }
        case "thinking_start":
          this.options.onEvent?.("thinking", { charCount: 0 });
          break;
        case "thinking_delta": {
          const delta = typeof ae.delta === "string" ? ae.delta : "";
          if (delta)
            this.options.onThinking?.(delta);
          this.options.onEvent?.("thinking", { charCount: delta.length });
          break;
        }
        case "toolcall_start":
          this.options.onToolStart?.(ae.name ?? ae.toolName ?? "tool");
          this.options.onEvent?.("toolcall");
          break;
        case "toolcall_end":
          this.options.onEvent?.("toolcall");
          break;
        case "done": {
          const tokenUsage = findTokenUsage(ae);
          const finishReason = findFinishReason(ae);
          this._updateTokenUsage(tokenUsage, "message_done");
          this._updateFinishReason(finishReason, "message_done");
          this.options.onEvent?.("message_done");
          break;
        }
        case "error": {
          const apiError = findApiErrorMessage(ae) ?? findApiErrorMessage(event);
          if (apiError) {
            this._apiError = apiError;
            this._metrics.api_error = apiError;
            this.options.onMetric?.({ type: "api_error", source: "rpc", errorMessage: apiError });
          }
          this.options.onEvent?.("message_error");
          break;
        }
      }
    }
  }
  sendCommand(cmd, timeoutMs = 30000) {
    return new Promise((resolve5, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("No stdin available"));
        return;
      }
      const id = this._nextRequestId++;
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`RPC timeout: no response for command id=${id} after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pendingRequests.set(id, { resolve: resolve5, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + `
`, (err) => {
        if (err) {
          const entry = this._pendingRequests.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this._pendingRequests.delete(id);
          }
          reject(err);
        }
      });
    });
  }
  async prompt(task) {
    this._stallError = undefined;
    this._markActivity();
    const response = await this.sendCommand({ type: "prompt", message: task });
    if (response?.success === false) {
      throw new Error(`Prompt rejected by pi: ${response.error ?? "already streaming"}`);
    }
  }
  async waitForDone(timeout) {
    const donePromise = this._donePromise ?? Promise.resolve();
    if (!timeout)
      return donePromise;
    return Promise.race([
      donePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Specialist timed out after ${timeout}ms`)), timeout))
    ]);
  }
  async getLastOutput() {
    if (!this.proc?.stdin || !this.proc.stdin.writable) {
      return this._lastOutput;
    }
    try {
      const response = await Promise.race([
        this.sendCommand({ type: "get_last_assistant_text" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))
      ]);
      return response?.data?.text ?? this._lastOutput;
    } catch {
      return this._lastOutput;
    }
  }
  async getState() {
    try {
      const response = await Promise.race([
        this.sendCommand({ type: "get_state" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))
      ]);
      return response?.data;
    } catch {
      return null;
    }
  }
  getMetrics() {
    return { ...this._metrics, ...this._metrics.token_usage ? { token_usage: { ...this._metrics.token_usage } } : {} };
  }
  async close() {
    if (this._killed)
      return;
    this._clearStallTimer();
    this.proc?.stdin?.end();
    if (this.proc) {
      const proc = this.proc;
      await new Promise((resolve5) => {
        proc.on("close", () => resolve5());
        setTimeout(() => {
          if (proc.exitCode === null && proc.pid != null) {
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {}
          }
          resolve5();
        }, 8000);
      });
    }
  }
  kill(reason) {
    if (this._killed)
      return;
    this._killed = true;
    this._clearStallTimer();
    if (this.proc?.stdin?.writable) {
      try {
        this.proc.stdin.write(JSON.stringify({ type: "abort" }) + `
`);
      } catch {}
    }
    const killError = reason ?? this._stallError ?? new SessionKilledError;
    for (const [, entry] of this._pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(killError);
    }
    this._pendingRequests.clear();
    const proc = this.proc;
    this.proc = undefined;
    proc?.kill();
    const pid = proc?.pid;
    if (pid != null) {
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }, 8000).unref();
    }
    this._doneReject?.(killError);
  }
  getStderr() {
    return this._stderrBuffer;
  }
  async steer(message) {
    if (this._killed || !this.proc?.stdin) {
      throw new Error("Session is not active");
    }
    const response = await this.sendCommand({ type: "steer", message });
    if (response?.success === false) {
      throw new Error(`Steer rejected by pi: ${response.error ?? "steer failed"}`);
    }
  }
  followUp(_task) {
    throw new Error("followUp() is not yet implemented. Use resume() to send a next-turn prompt to a waiting session.");
  }
  async resume(task, timeout) {
    if (this._killed || !this.proc?.stdin) {
      throw new Error("Session is not active");
    }
    this._agentEndReceived = false;
    const donePromise = new Promise((resolve5, reject) => {
      this._doneResolve = resolve5;
      this._doneReject = reject;
    });
    donePromise.catch(() => {});
    this._donePromise = donePromise;
    await this.prompt(task);
    await this.waitForDone(timeout);
  }
}

// src/specialist/mandatory-rules.ts
import { existsSync as existsSync8, readFileSync as readFileSync4 } from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import { resolve as resolve6 } from "node:path";

// src/specialist/memory-retrieval.ts
import { execSync } from "node:child_process";

// src/specialist/observability-sqlite.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync3, readFileSync as readFileSync3, statSync } from "node:fs";
import { dirname as dirname5, join as join6, normalize, resolve as resolve5 } from "node:path";

// src/specialist/observability-db.ts
import { chmodSync, existsSync as existsSync6, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { spawnSync } from "node:child_process";
import { join as join5, sep as sep2, resolve as resolvePath } from "node:path";
var OBSERVABILITY_DB_FILENAME = "observability.db";
var DEFAULT_DB_DIRECTORY_RELATIVE_TO_GIT_ROOT = [".specialists", "db"];
function resolveGitRootFrom(cwd) {
  const commonDirResult = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (commonDirResult.status === 0) {
    const commonDir = commonDirResult.stdout.trim();
    if (commonDir.length > 0 && commonDir.endsWith(`${sep2}.git`)) {
      return commonDir.slice(0, -4);
    }
  }
  const fallbackResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (fallbackResult.status !== 0)
    return cwd;
  const gitRoot = fallbackResult.stdout.trim();
  return gitRoot.length > 0 ? gitRoot : cwd;
}
function resolveDbDirectory(gitRoot) {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return { directory: join5(xdgDataHome, "specialists"), source: "xdg-data-home" };
  }
  return {
    directory: join5(gitRoot, ...DEFAULT_DB_DIRECTORY_RELATIVE_TO_GIT_ROOT),
    source: "git-root"
  };
}
function relocateIfForbidden(directory) {
  const forbidden = process.env.SPECIALISTS_FORBID_DB_DIR?.trim();
  const fallback = process.env.SPECIALISTS_FALLBACK_DB_DIR?.trim();
  if (!forbidden || !fallback)
    return directory;
  return resolvePath(directory) === resolvePath(forbidden) ? fallback : directory;
}
function resolveObservabilityDbLocation(cwd = process.cwd()) {
  const gitRoot = resolveGitRootFrom(cwd);
  const resolved = resolveDbDirectory(gitRoot);
  const directory = relocateIfForbidden(resolved.directory);
  const dbPath = join5(directory, OBSERVABILITY_DB_FILENAME);
  return {
    gitRoot,
    dbDirectory: directory,
    dbPath,
    dbWalPath: `${dbPath}-wal`,
    dbShmPath: `${dbPath}-shm`,
    source: resolved.source
  };
}
function ensureObservabilityDbFile(location) {
  mkdirSync2(location.dbDirectory, { recursive: true });
  const alreadyExists = existsSync6(location.dbPath);
  if (alreadyExists) {
    chmodSync(location.dbPath, 420);
  }
  return { created: !alreadyExists };
}

// src/specialist/forensic-events.ts
var FORENSIC_SCHEMA_VERSION = "xtrm.forensic.v1";
var NODE_ENV_KEY = ["NODE", "ENV"].join("_");
function deploymentEnvironment() {
  return process.env[NODE_ENV_KEY]?.trim() || "local";
}
var FORBIDDEN_PROMETHEUS_LABELS = new Set([
  "participant_id",
  "job_id",
  "bead_id",
  "issue_id",
  "container_id",
  "chain_id",
  "chain_root_job_id",
  "chain_root_bead_id",
  "epic_id",
  "node_id",
  "pulse_id",
  "turn_id",
  "tool_call_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "session_id",
  "conversation_id",
  "mcp_session_id",
  "jsonrpc_request_id",
  "eval_id",
  "policy_decision_id",
  "identity_request_id",
  "commit_sha",
  "raw_path",
  "raw_command",
  "raw_error",
  "raw_diff",
  "raw_url",
  "prompt",
  "model_output",
  "user_id",
  "email",
  "token",
  "credential",
  "parent_job_id",
  "agent_instance_id",
  "host_id",
  "tmux_session_id",
  "tmux_window_id",
  "tmux_pane_id"
]);
var DEFAULT_LABEL_ALLOWLIST = new Set([
  "service_namespace",
  "service_name",
  "service_component",
  "deployment_environment",
  "repo",
  "participant_kind",
  "participant_role",
  "event_family",
  "severity",
  "state",
  "status",
  "result",
  "model_provider",
  "model",
  "tool_name",
  "mcp_server",
  "mcp_method",
  "error_type",
  "drift_tier",
  "pulse_kind",
  "policy_kind",
  "action_kind",
  "resource_kind",
  "credential_kind",
  "eval_kind",
  "chain_template",
  "gate_kind",
  "verdict",
  "severity_level",
  "direction",
  "reason",
  "process_kind",
  "evidence_kind",
  "target",
  "highest_risk"
]);
var ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "timestamp",
  "t_unix_ms",
  "seq",
  "severity",
  "event_family",
  "event_name",
  "event_version",
  "resource",
  "correlation",
  "body",
  "redaction",
  "trace",
  "otel",
  "links",
  "diagnostics"
]);
var REDACTED = "[REDACTED]";
var REDACTION_RULES = {
  sensitiveField: "sensitive-field-name",
  secretPattern: "secret-pattern"
};
var SENSITIVE_FIELD_RE = /(^|_)(password|secret|credential|api_?key|access_?token|refresh_?token|auth_?token|bearer|email|prompt|model_?output|raw_?command|raw_?url|raw_?error|stderr|stdout|args|arguments|input|output|content)$/i;
var SECRET_VALUE_RE = /(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{12,}|xox[baprs]-[a-z0-9-]{12,}|bearer\s+[a-z0-9._-]{12,})/i;
function redactForensicValue(value, path = "body") {
  const fields = new Set;
  const rules = new Set;
  function visit(input, currentPath) {
    if (Array.isArray(input))
      return input.map((item, index) => visit(item, `${currentPath}[${index}]`));
    if (input && typeof input === "object") {
      const output = {};
      for (const [key, nested] of Object.entries(input)) {
        const nextPath = `${currentPath}.${key}`;
        if (isSensitiveField(key)) {
          output[key] = REDACTED;
          fields.add(nextPath);
          rules.add(REDACTION_RULES.sensitiveField);
          continue;
        }
        output[key] = visit(nested, nextPath);
      }
      return output;
    }
    if (typeof input === "string" && SECRET_VALUE_RE.test(input)) {
      fields.add(currentPath);
      rules.add(REDACTION_RULES.secretPattern);
      return input.replace(SECRET_VALUE_RE, REDACTED);
    }
    return input;
  }
  return {
    value: visit(value, path),
    fields: Array.from(fields).sort(),
    rules: Array.from(rules).sort()
  };
}
var NON_SENSITIVE_TELEMETRY_BODY_FIELDS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "tool_tokens",
  "total_tokens",
  "usage_source",
  "credential_kind",
  "policy_kind",
  "action_kind",
  "resource_kind",
  "eval_kind",
  "target_kind",
  "scope_kind",
  "provider",
  "ttl_seconds",
  "retryable",
  "result",
  "score",
  "threshold",
  "scale",
  "severity",
  "reason_code",
  "mismatch_kind"
]);
function isSensitiveField(key) {
  if (NON_SENSITIVE_TELEMETRY_BODY_FIELDS.has(key))
    return false;
  return SENSITIVE_FIELD_RE.test(key);
}
function mergeRedaction(explicit, result) {
  const fields = [...new Set([...explicit?.fields ?? [], ...result.fields])].sort();
  const rules = [...new Set([...explicit?.rules ?? [], ...result.rules])].sort();
  const status = explicit?.status === "unknown" ? "unknown" : explicit?.status === "redacted" || fields.length > 0 ? "redacted" : "clean";
  return {
    status,
    ...fields.length > 0 ? { fields } : {},
    ...rules.length > 0 ? { rules } : {}
  };
}
function createForensicEvent(options) {
  const tUnixMs = options.t_unix_ms ?? Date.now();
  const redactionResult = redactForensicValue(options.body ?? {}, "body");
  const explicitRedaction = options.redaction;
  const event = {
    schema_version: FORENSIC_SCHEMA_VERSION,
    timestamp: options.timestamp ?? new Date(tUnixMs).toISOString(),
    t_unix_ms: tUnixMs,
    severity: options.severity ?? "info",
    event_family: options.event_family,
    event_name: options.event_name,
    event_version: options.event_version ?? 1,
    resource: normalizeResource(options.resource),
    correlation: options.correlation ?? {},
    body: redactionResult.value,
    redaction: mergeRedaction(explicitRedaction, redactionResult)
  };
  if (options.seq !== undefined)
    event.seq = options.seq;
  if (options.trace)
    event.trace = options.trace;
  if (options.otel)
    event.otel = options.otel;
  if (options.links)
    event.links = options.links;
  if (options.diagnostics)
    event.diagnostics = options.diagnostics;
  assertKnownTopLevelFields(event);
  return event;
}
function normalizeResource(resource) {
  const normalized = { ...resource };
  const legacySpecialist = normalized.specialist;
  if (!normalized.participant_kind && typeof legacySpecialist === "string") {
    normalized.participant_kind = "specialist";
  }
  if (!normalized.participant_role && typeof legacySpecialist === "string") {
    normalized.participant_role = legacySpecialist;
  }
  delete normalized.specialist;
  return normalized;
}
function deriveParticipantId(input) {
  if ((input.participant_kind ?? "specialist") === "specialist") {
    const role = typeof input.participant_role === "string" ? input.participant_role.trim() : "";
    return `specialist::${role ? role : "<unknown>"}`;
  }
  if (input.participant_kind === "orchestrator" && input.session_uuid)
    return `orch::${input.session_uuid}`;
  if (input.participant_kind === "pulse_emitter" && input.container_id)
    return `${input.container_id}::emitter::${input.participant_role}`;
  if (input.participant_kind === "node_member" && input.node_id)
    return `node::${input.node_id}::${input.participant_role}::${input.member_index ?? 0}`;
  if (input.participant_kind === "adapter" && input.adapter_id)
    return input.adapter_id;
  return `${input.participant_kind ?? "specialist"}::<unknown>`;
}
function assertKnownTopLevelFields(event) {
  for (const key of Object.keys(event)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      throw new Error(`Unknown forensic event top-level field: ${key}`);
    }
  }
}
function projectSpawnedByLink(spawnOrigin) {
  if (!spawnOrigin || typeof spawnOrigin !== "object")
    return;
  const o = spawnOrigin;
  if (o.kind === "xtmux.agent_instance") {
    const ro = o.runtime_origin;
    if (!ro || typeof ro !== "object")
      return;
    if (typeof ro.host_id !== "string" || typeof ro.tmux_session_id !== "string" || typeof ro.tmux_window_id !== "string" || typeof ro.tmux_pane_id !== "string") {
      return;
    }
    return {
      kind: "xtmux.agent_instance",
      host_id: ro.host_id,
      tmux_session_id: ro.tmux_session_id,
      tmux_window_id: ro.tmux_window_id,
      tmux_pane_id: ro.tmux_pane_id,
      ...typeof ro.agent_instance_id === "string" ? { agent_instance_id: ro.agent_instance_id } : {}
    };
  }
  if (o.kind === "specialist.job" && typeof o.parent_job_id === "string") {
    return { kind: "specialist.job", job_id: o.parent_job_id };
  }
  return;
}
function projectRootRuntimeOrigin(rootRuntimeOrigin) {
  if (!rootRuntimeOrigin || typeof rootRuntimeOrigin !== "object")
    return;
  const ro = rootRuntimeOrigin;
  if (typeof ro.host_id !== "string" || typeof ro.tmux_pane_id !== "string")
    return;
  return {
    kind: "xtmux.agent_instance",
    host_id: ro.host_id,
    tmux_pane_id: ro.tmux_pane_id,
    ...typeof ro.agent_instance_id === "string" ? { agent_instance_id: ro.agent_instance_id } : {}
  };
}
function deriveOriginSource(spawnOrigin, rootRuntimeOrigin) {
  if (!spawnOrigin || typeof spawnOrigin !== "object")
    return "none";
  const o = spawnOrigin;
  if (o.kind === "specialist.job")
    return "child-of-specialist";
  if (o.kind === "xtmux.agent_instance") {
    const ro = o.runtime_origin ?? rootRuntimeOrigin;
    if (ro && ro.capture_source === "propagated")
      return "propagated";
    return "xtmux-context";
  }
  return "none";
}
function deriveOriginVerified(rootRuntimeOrigin) {
  if (!rootRuntimeOrigin || typeof rootRuntimeOrigin !== "object")
    return false;
  return rootRuntimeOrigin.verified === true;
}
function deriveOriginSourceFromRoot(rootRuntimeOrigin) {
  if (!rootRuntimeOrigin || typeof rootRuntimeOrigin !== "object")
    return "unknown";
  const capture = rootRuntimeOrigin.capture_source;
  if (capture === "propagated")
    return "propagated";
  if (capture === "xtmux-context")
    return "xtmux-context";
  return "unknown";
}
function forensicEventFromTimelineEvent(event, context) {
  const participantRole = context.specialist;
  const participantKind = context.nodeId ? "node_member" : "specialist";
  const participantId = deriveParticipantId({
    participant_kind: participantKind,
    participant_role: participantRole,
    chain_id: context.chainId,
    node_id: context.nodeId
  });
  return createForensicEvent({
    event_family: familyForTimelineType(event.type),
    event_name: eventNameForTimelineEvent(event),
    severity: severityForTimelineEvent(event),
    resource: {
      service_namespace: "xtrm",
      service_name: "specialists",
      service_component: context.serviceComponent ?? "runtime",
      deployment_environment: deploymentEnvironment(),
      repo: context.repo ?? "unknown",
      participant_kind: participantKind,
      participant_role: participantRole,
      model_provider: context.backend,
      model: context.model,
      chain_kind: context.chainKind
    },
    correlation: {
      participant_id: participantId,
      job_id: context.jobId,
      bead_id: context.beadId,
      node_id: context.nodeId,
      attempt_id: context.attemptId,
      pi_session_id: context.piSessionId ?? context.sessionId,
      workspace_id: context.workspaceId,
      chain_id: context.chainId,
      chain_root_job_id: context.chainRootJobId,
      chain_root_bead_id: context.chainRootBeadId,
      epic_id: context.epicId,
      session_id: context.sessionId ?? stringField(event, "session_id"),
      conversation_id: context.conversationId ?? stringField(event, "conversation_id"),
      trace_id: context.traceId ?? stringField(event, "trace_id") ?? metaStringField(event, "trace_id"),
      span_id: context.spanId ?? stringField(event, "span_id") ?? metaStringField(event, "span_id"),
      parent_span_id: context.parentSpanId ?? stringField(event, "parent_span_id") ?? metaStringField(event, "parent_span_id"),
      mcp_session_id: stringField(event, "mcp_session_id") ?? metaStringField(event, "mcp_session_id") ?? metaStringField(event, "mcp.session.id"),
      jsonrpc_request_id: stringField(event, "jsonrpc_request_id") ?? metaStringField(event, "jsonrpc_request_id") ?? metaStringField(event, "jsonrpc.request.id"),
      tool_call_id: typeof event.tool_call_id === "string" ? event.tool_call_id : undefined,
      commit_sha: typeof event.commit_sha === "string" ? event.commit_sha : undefined,
      ...context.parentJobId ? { parent_job_id: context.parentJobId } : {}
    },
    body: bodyForTimelineEvent(event, context),
    otel: otelForTimelineEvent(event),
    redaction: { status: redactionStatusForTimelineEvent(event) },
    t_unix_ms: event.t,
    seq: event.seq,
    ...event.type === "run_start" ? buildRunStartLinks(context) : {}
  });
}
function stringField(source, key) {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function metaStringField(source, key) {
  const meta = source._meta;
  if (!meta || typeof meta !== "object")
    return;
  return stringField(meta, key);
}
function numberField(source, key) {
  const value = Number(source[key]);
  return Number.isFinite(value) ? value : undefined;
}
function booleanField(source, key) {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}
function buildRunStartLinks(context) {
  const spawnedBy = projectSpawnedByLink(context.spawnOrigin);
  const rootOrigin = projectRootRuntimeOrigin(context.rootRuntimeOrigin);
  if (!spawnedBy && !rootOrigin)
    return {};
  return {
    links: {
      ...spawnedBy ? { spawned_by: spawnedBy } : {},
      ...rootOrigin ? { root_runtime_origin: rootOrigin } : {}
    }
  };
}
function bodyForTimelineEvent(event, context) {
  if (event.type === "run_start") {
    const originSource = deriveOriginSource(context?.spawnOrigin, context?.rootRuntimeOrigin);
    const originVerified = deriveOriginVerified(context?.rootRuntimeOrigin);
    const rootOriginSource = deriveOriginSourceFromRoot(context?.rootRuntimeOrigin);
    return {
      legacy_timeline_event: event,
      specialist: stringField(event, "specialist"),
      bead_id: stringField(event, "bead_id"),
      launch_mode: originSource === "propagated" ? "background" : originSource === "xtmux-context" ? "foreground" : originSource === "child-of-specialist" ? rootOriginSource === "propagated" ? "background" : rootOriginSource === "xtmux-context" ? "foreground" : "unknown" : "unknown",
      origin_source: originSource,
      origin_verified: originVerified
    };
  }
  if (event.type === "mcp") {
    return {
      legacy_timeline_event: event,
      mcp_server: stringField(event, "mcp_server") ?? stringField(event, "server") ?? "unknown",
      mcp_method: stringField(event, "mcp_method") ?? stringField(event, "method") ?? "tools/call",
      tool_name: stringField(event, "tool_name") ?? stringField(event, "tool"),
      network_transport: stringField(event, "network_transport") ?? stringField(event, "transport"),
      duration_ms: numberField(event, "duration_ms"),
      error_type: stringField(event, "error_type"),
      status_code: stringField(event, "status_code"),
      duplicate_span_suppressed: booleanField(event, "duplicate_span_suppressed"),
      trace_carrier: metaStringField(event, "trace_carrier") ?? (event._meta && typeof event._meta === "object" ? "_meta" : undefined)
    };
  }
  if (event.type === "token_usage") {
    return {
      legacy_timeline_event: event,
      input_tokens: numberField(event, "input_tokens") ?? numberField(event, "input"),
      output_tokens: numberField(event, "output_tokens") ?? numberField(event, "output"),
      cache_read_tokens: numberField(event, "cache_read_tokens") ?? numberField(event, "cache_read"),
      cache_creation_tokens: numberField(event, "cache_creation_tokens") ?? numberField(event, "cache_creation"),
      reasoning_tokens: numberField(event, "reasoning_tokens") ?? numberField(event, "reasoning") ?? numberField(event, "thinking_tokens"),
      tool_tokens: numberField(event, "tool_tokens") ?? numberField(event, "tool") ?? numberField(event, "tool_use_tokens"),
      total_tokens: numberField(event, "total_tokens") ?? numberField(event, "total"),
      usage_source: stringField(event, "usage_source") ?? stringField(event, "source") ?? "runtime_event"
    };
  }
  if (event.type === "run_complete") {
    return {
      legacy_timeline_event: event,
      status: stringField(event, "status"),
      output: stringField(event, "output"),
      error: stringField(event, "error"),
      commit_sha: stringField(event, "commit_sha"),
      evidence_refs: evidenceRefsForTimelineEvent(event)
    };
  }
  if (event.type === "auto_commit_success" || event.type === "auto_commit_skipped" || event.type === "auto_commit_failed") {
    const committedFiles = Array.isArray(event.committed_files) ? event.committed_files.filter((file) => typeof file === "string") : [];
    return {
      legacy_timeline_event: event,
      evidence_kind: event.type === "auto_commit_success" ? "commit" : "report",
      result: event.type === "auto_commit_success" ? "success" : event.type === "auto_commit_failed" ? "error" : "skipped",
      commit_sha: stringField(event, "commit_sha"),
      changed_paths_count: committedFiles.length,
      changed_paths: committedFiles,
      evidence_refs: evidenceRefsForTimelineEvent(event),
      reason: stringField(event, "reason")
    };
  }
  if (event.type === "command_completed" || event.type === "command_failed") {
    return {
      legacy_timeline_event: event,
      command_kind: stringField(event, "command_kind") ?? "unknown",
      duration_ms: numberField(event, "duration_ms"),
      status: event.type === "command_completed" ? "success" : "error",
      command: stringField(event, "command"),
      args: Array.isArray(event.args) ? event.args.filter((arg) => typeof arg === "string") : undefined,
      exit_code: numberField(event, "exit_code"),
      stderr: stringField(event, "stderr"),
      redacted: booleanField(event, "redacted")
    };
  }
  if (event.type === "review_verdict_pass" || event.type === "review_verdict_partial" || event.type === "review_verdict_fail" || event.type === "review_verdict_waived") {
    return {
      legacy_timeline_event: event,
      verdict: event.type.replace("review_verdict_", ""),
      chain_template: stringField(event, "chain_template"),
      changed_paths_count: numberField(event, "changed_paths_count"),
      terminal_state: stringField(event, "terminal_state"),
      result: stringField(event, "result")
    };
  }
  if (event.type === "chain_ready_for_review" || event.type === "chain_finalized") {
    return {
      legacy_timeline_event: event,
      chain_template: stringField(event, "chain_template"),
      changed_paths_count: numberField(event, "changed_paths_count"),
      terminal_state: stringField(event, "terminal_state"),
      result: stringField(event, "result")
    };
  }
  if (event.type === "worktree_merged") {
    return {
      legacy_timeline_event: event,
      changed_paths_count: numberField(event, "changed_paths_count"),
      merge_ref: stringField(event, "merge_ref"),
      source_ref: stringField(event, "source_ref"),
      target_ref: stringField(event, "target_ref"),
      result: stringField(event, "result")
    };
  }
  return { legacy_timeline_event: event };
}
function evidenceRefsForTimelineEvent(event) {
  if (!Array.isArray(event.evidence))
    return;
  const refs = event.evidence.filter((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry));
  return refs.length > 0 ? refs : undefined;
}
function otelForTimelineEvent(event) {
  if (event.type !== "mcp")
    return;
  const method = stringField(event, "mcp_method") ?? stringField(event, "method") ?? "tools/call";
  return {
    "mcp.method.name": method,
    "mcp.session.id": stringField(event, "mcp_session_id") ?? metaStringField(event, "mcp_session_id") ?? metaStringField(event, "mcp.session.id"),
    "jsonrpc.request.id": stringField(event, "jsonrpc_request_id") ?? metaStringField(event, "jsonrpc_request_id") ?? metaStringField(event, "jsonrpc.request.id"),
    "network.transport": stringField(event, "network_transport") ?? stringField(event, "transport"),
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": stringField(event, "tool_name") ?? stringField(event, "tool")
  };
}
function familyForTimelineType(type) {
  if (type === "run_start" || type === "run_complete" || type === "status_change" || type === "payload_breakdown")
    return "job";
  if (type === "mcp")
    return "mcp";
  if (type === "tool")
    return "tool";
  if (type === "turn" || type === "turn_summary" || type === "message" || type === "text" || type === "thinking")
    return "turn";
  if (type === "token_usage" || type === "finish_reason" || type === "model_change" || type === "meta")
    return "model";
  if (type === "control_signal")
    return "control";
  if (type === "retry")
    return "retry";
  if (type === "compaction")
    return "compaction";
  if (type === "error" || type === "extension_error")
    return "error";
  if (type === "auto_commit_success" || type === "auto_commit_skipped" || type === "auto_commit_failed")
    return "git";
  if (type === "command_completed" || type === "command_failed")
    return "command";
  if (type === "review_verdict_pass" || type === "review_verdict_partial" || type === "review_verdict_fail" || type === "review_verdict_waived")
    return "review";
  if (type === "chain_ready_for_review" || type === "chain_finalized")
    return "chain";
  if (type === "worktree_merged")
    return "worktree";
  if (type === "stale_warning")
    return "process_health";
  return "job";
}
function eventNameForTimelineEvent(event) {
  if (event.type === "run_start")
    return "job.started";
  if (event.type === "run_complete") {
    if (event.status === "ERROR")
      return "job.failed";
    if (event.status === "CANCELLED")
      return "job.cancelled";
    return "job.completed";
  }
  if (event.type === "status_change")
    return "job.status_changed";
  if (event.type === "mcp")
    return mcpEventNameForTimelineEvent(event);
  if (event.type === "tool") {
    if (event.phase === "start")
      return "tool.call.started";
    if (event.is_error)
      return "tool.call.failed";
    return "tool.call.completed";
  }
  if (event.type === "turn_summary")
    return "turn.summarized";
  if (event.type === "token_usage")
    return "model.token_usage.recorded";
  if (event.type === "finish_reason")
    return "model.finish_reason.recorded";
  if (event.type === "model_change")
    return "model.changed";
  if (event.type === "control_signal")
    return `control.${String(event.action ?? "signal")}.recorded`;
  if (event.type === "retry")
    return `retry.${String(event.phase ?? "recorded")}`;
  if (event.type === "compaction")
    return `compaction.${String(event.phase ?? "recorded")}`;
  if (event.type === "extension_error")
    return "error.extension";
  if (event.type === "error")
    return "error.rpc";
  if (event.type === "auto_commit_success")
    return "git.auto_commit.succeeded";
  if (event.type === "auto_commit_skipped")
    return "git.auto_commit.skipped";
  if (event.type === "auto_commit_failed")
    return "git.auto_commit.failed";
  if (event.type === "command_completed")
    return "command.completed";
  if (event.type === "command_failed")
    return "command.failed";
  if (event.type === "review_verdict_pass")
    return "review.verdict.pass";
  if (event.type === "review_verdict_partial")
    return "review.verdict.partial";
  if (event.type === "review_verdict_fail")
    return "review.verdict.fail";
  if (event.type === "review_verdict_waived")
    return "review.verdict.waived";
  if (event.type === "chain_ready_for_review")
    return "chain.ready_for_review";
  if (event.type === "chain_finalized")
    return "chain.finalized";
  if (event.type === "worktree_merged")
    return "worktree.merged";
  if (event.type === "stale_warning")
    return "process_health.stale_detected";
  return `${familyForTimelineType(event.type)}.${event.type}`;
}
function mcpEventNameForTimelineEvent(event) {
  const explicit = stringField(event, "event_name");
  if (explicit?.startsWith("mcp."))
    return explicit;
  const action = stringField(event, "action") ?? stringField(event, "phase") ?? stringField(event, "status");
  if (action === "connected")
    return "mcp.connected";
  if (action === "disconnected")
    return "mcp.disconnected";
  if (action === "auth_failed")
    return "mcp.auth.failed";
  if (action === "rate_limited")
    return "mcp.rate_limited";
  if (action === "latency_observed")
    return "mcp.latency.observed";
  if (action === "start" || action === "started")
    return "mcp.call.started";
  if (event.is_error || action === "failed" || action === "error")
    return "mcp.call.failed";
  return "mcp.call.completed";
}
function severityForTimelineEvent(event) {
  if (event.type === "error" || event.type === "extension_error" || event.type === "auto_commit_failed" || event.type === "command_failed")
    return "error";
  if (event.type === "mcp" && (event.is_error || mcpEventNameForTimelineEvent(event).endsWith(".failed") || mcpEventNameForTimelineEvent(event) === "mcp.auth.failed"))
    return "error";
  if (event.type === "mcp" && mcpEventNameForTimelineEvent(event) === "mcp.rate_limited")
    return "warn";
  if (event.type === "stale_warning" || event.type === "control_signal")
    return "warn";
  if (event.type === "run_complete" && event.status === "ERROR")
    return "error";
  if (event.type === "tool" && event.is_error)
    return "error";
  return "info";
}
function redactionStatusForTimelineEvent(event) {
  if (event.type === "tool" || event.type === "turn_summary" || event.type === "run_complete" || event.type === "command_completed" || event.type === "command_failed" || event.type === "review_verdict_pass" || event.type === "review_verdict_partial" || event.type === "review_verdict_fail" || event.type === "review_verdict_waived" || event.type === "chain_ready_for_review" || event.type === "chain_finalized" || event.type === "worktree_merged")
    return "redacted";
  return "clean";
}

// src/specialist/observability-sqlite.ts
var _BunDatabase = null;
var _probed = false;
function nodeSqliteAdapter() {
  let DatabaseSync;
  try {
    DatabaseSync = __require("node:sqlite").DatabaseSync;
  } catch {
    return null;
  }
  if (!DatabaseSync)
    return null;
  return class NodeSqliteDatabase {
    inner;
    constructor(path) {
      this.inner = new DatabaseSync(path);
    }
    run(sql, ...params) {
      if (params.length === 0) {
        this.inner.exec(sql);
        return;
      }
      return this.inner.prepare(sql).run(...params);
    }
    query(sql) {
      return this.inner.prepare(sql);
    }
    transaction(fn) {
      const self = this;
      return function wrapped(...args) {
        self.inner.exec("BEGIN");
        try {
          const out = fn.apply(this, args);
          self.inner.exec("COMMIT");
          return out;
        } catch (error) {
          try {
            self.inner.exec("ROLLBACK");
          } catch {}
          throw error;
        }
      };
    }
    close() {
      this.inner.close();
    }
  };
}
function loadBunDatabase() {
  if (_probed)
    return _BunDatabase;
  _probed = true;
  try {
    _BunDatabase = __require("bun:sqlite").Database;
  } catch {
    _BunDatabase = nodeSqliteAdapter();
  }
  return _BunDatabase;
}
var BUSY_TIMEOUT_MS = 5000;
var MAX_RETRY_ATTEMPTS = 5;
var BASE_RETRY_DELAY_MS = 50;
function calculateRetryDelay(attempt) {
  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_RETRY_DELAY_MS;
  return Math.min(exponentialDelay + jitter, BUSY_TIMEOUT_MS);
}
function withRetry(operation, context) {
  let lastError;
  for (let attempt = 0;attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.includes("Cannot use a closed database")) {
        throw new Error(`[observability-sqlite] SQLite client is closed (${context})`);
      }
      const isRetryable = lastError.message.includes("SQLITE_BUSY") || lastError.message.includes("SQLITE_LOCKED") || lastError.message.includes("database is locked") || lastError.message.includes("database is busy");
      if (!isRetryable || attempt === MAX_RETRY_ATTEMPTS - 1) {
        break;
      }
      const delayMs = calculateRetryDelay(attempt);
      Bun.sleepSync(delayMs);
    }
  }
  throw new Error(`Failed after ${MAX_RETRY_ATTEMPTS} attempts (${context}): ${lastError?.message ?? "unknown error"}`);
}
function parseJournalMode(mode) {
  if (!mode)
    return null;
  return mode.toLowerCase();
}
function enforceWalMode(db) {
  const result = db.query("PRAGMA journal_mode=WAL").get();
  const mode = parseJournalMode(result?.journal_mode);
  if (mode !== "wal") {
    throw new Error(`Failed to enable WAL journal mode (got: ${mode ?? "null"})`);
  }
}
function verifyWalMode(db) {
  const result = db.query("PRAGMA journal_mode").get();
  const mode = parseJournalMode(result?.journal_mode);
  if (mode !== "wal") {
    throw new Error(`WAL journal mode is not active (got: ${mode ?? "null"})`);
  }
}
function migrateToV2(db) {
  const hasV2 = db.query("SELECT 1 FROM schema_version WHERE version = 2 LIMIT 1").get();
  if (hasV2) {
    db.run("CREATE INDEX IF NOT EXISTS idx_jobs_bead ON specialist_jobs(bead_id) WHERE bead_id IS NOT NULL");
    return;
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_jobs_v2 (
      job_id          TEXT PRIMARY KEY,
      specialist      TEXT NOT NULL,
      worktree_column TEXT,
      status_json     TEXT NOT NULL,
      bead_id         TEXT,
      updated_at_ms   INTEGER NOT NULL,
      last_output     TEXT,
      startup_payload_json TEXT
    );
    INSERT OR IGNORE INTO specialist_jobs_v2
      SELECT
        job_id,
        specialist,
        worktree_column,
        status_json,
        JSON_EXTRACT(status_json, '$.bead_id'),
        updated_at_ms,
        last_output,
        startup_payload_json
      FROM specialist_jobs;
    DROP TABLE IF EXISTS specialist_jobs;
    ALTER TABLE specialist_jobs_v2 RENAME TO specialist_jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_bead ON specialist_jobs(bead_id) WHERE bead_id IS NOT NULL;
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (2, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV3(db) {
  const hasV3 = db.query("SELECT 1 FROM schema_version WHERE version = 3 LIMIT 1").get();
  if (hasV3) {
    db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status ON specialist_jobs(status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_jobs_node ON specialist_jobs(node_id) WHERE node_id IS NOT NULL");
    db.run("CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON specialist_jobs(status, updated_at_ms DESC)");
    return;
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_jobs_v3 (
      job_id          TEXT PRIMARY KEY,
      specialist      TEXT NOT NULL,
      worktree_column TEXT,
      bead_id         TEXT,
      node_id         TEXT,
      status          TEXT NOT NULL,
      status_json     TEXT NOT NULL,
      updated_at_ms   INTEGER NOT NULL,
      last_output     TEXT,
      startup_payload_json TEXT
    );
    INSERT OR IGNORE INTO specialist_jobs_v3
      SELECT
        job_id,
        specialist,
        worktree_column,
        bead_id,
        NULL,
        COALESCE(JSON_EXTRACT(status_json, '$.status'), 'starting'),
        status_json,
        updated_at_ms,
        last_output,
        startup_payload_json
      FROM specialist_jobs;
    DROP TABLE IF EXISTS specialist_jobs;
    ALTER TABLE specialist_jobs_v3 RENAME TO specialist_jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_bead ON specialist_jobs(bead_id) WHERE bead_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON specialist_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_node ON specialist_jobs(node_id) WHERE node_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON specialist_jobs(status, updated_at_ms DESC);
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (3, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV11(db) {
  const hasV11 = db.query("SELECT 1 FROM schema_version WHERE version = 11 LIMIT 1").get();
  if (hasV11) {
    const metricsColumns = new Set(db.query("PRAGMA table_info(specialist_job_metrics)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
    for (const column of [
      { name: "active_runtime_ms", definition: "INTEGER" },
      { name: "waiting_ms", definition: "INTEGER" },
      { name: "startup_payload_json", definition: "TEXT" }
    ]) {
      if (!metricsColumns.has(column.name)) {
        db.run(`ALTER TABLE specialist_job_metrics ADD COLUMN ${column.name} ${column.definition}`);
      }
    }
    db.run("CREATE INDEX IF NOT EXISTS idx_job_metrics_spec_model_updated ON specialist_job_metrics(specialist, model, updated_at_ms DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_job_metrics_updated ON specialist_job_metrics(updated_at_ms DESC)");
    return;
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_job_metrics (
      job_id TEXT PRIMARY KEY,
      specialist TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      chain_kind TEXT,
      chain_id TEXT,
      bead_id TEXT,
      node_id TEXT,
      epic_id TEXT,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      elapsed_ms INTEGER,
      active_runtime_ms INTEGER,
      waiting_ms INTEGER,
      total_turns INTEGER NOT NULL DEFAULT 0,
      total_tools INTEGER NOT NULL DEFAULT 0,
      tool_call_counts_json TEXT NOT NULL,
      token_trajectory_json TEXT NOT NULL,
      context_trajectory_json TEXT NOT NULL,
      stall_gaps_json TEXT NOT NULL,
      run_complete_json TEXT,
      startup_payload_json TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_metrics_spec_model_updated ON specialist_job_metrics(specialist, model, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_job_metrics_updated ON specialist_job_metrics(updated_at_ms DESC);
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (11, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV12(db) {
  const hasV12 = db.query("SELECT 1 FROM schema_version WHERE version = 12 LIMIT 1").get();
  db.run(`
    CREATE TABLE IF NOT EXISTS specialist_forensic_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id             TEXT NOT NULL,
      seq                INTEGER NOT NULL,
      t                  INTEGER NOT NULL,
      schema_version     TEXT NOT NULL,
      event_family       TEXT NOT NULL,
      event_name         TEXT NOT NULL,
      participant_kind   TEXT,
      participant_role   TEXT,
      participant_id     TEXT,
      redaction_status   TEXT NOT NULL,
      event_json         TEXT NOT NULL
    );
  `);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_forensic_events_job_seq ON specialist_forensic_events(job_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS idx_forensic_events_job_t ON specialist_forensic_events(job_id, t, seq, id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_forensic_events_family ON specialist_forensic_events(event_family, event_name, t)");
  db.run("CREATE INDEX IF NOT EXISTS idx_forensic_events_participant ON specialist_forensic_events(participant_kind, participant_role, t)");
  if (hasV12)
    return;
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (12, strftime('%s', 'now') * 1000);
  `);
}
function parseJsonRecord(input) {
  if (!input)
    return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function stringifyJson(value) {
  return JSON.stringify(value);
}
function normalizeWorkspacePath(worktreePath) {
  if (!worktreePath || worktreePath.trim().length === 0)
    return null;
  return normalize(resolve5(worktreePath));
}
function buildAttemptId(jobId, attemptNo) {
  return `${jobId}::attempt::${attemptNo}`;
}
function isRetryStartEvent(event) {
  return event.type === "retry" && event.phase === "start";
}
function migrateToV4(db) {
  const hasV4 = db.query("SELECT 1 FROM schema_version WHERE version = 4 LIMIT 1").get();
  if (hasV4) {
    db.run("CREATE TABLE IF NOT EXISTS node_runs (id TEXT PRIMARY KEY, node_name TEXT NOT NULL, status TEXT NOT NULL, coordinator_job_id TEXT, started_at_ms INTEGER, updated_at_ms INTEGER NOT NULL, waiting_on TEXT, error TEXT, memory_namespace TEXT, status_json TEXT NOT NULL)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_runs_status ON node_runs(status)");
    db.run("CREATE TABLE IF NOT EXISTS node_members (id INTEGER PRIMARY KEY AUTOINCREMENT, node_run_id TEXT NOT NULL, member_id TEXT NOT NULL, job_id TEXT, specialist TEXT NOT NULL, model TEXT, role TEXT, status TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 0)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_members_run ON node_members(node_run_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_members_job ON node_members(job_id) WHERE job_id IS NOT NULL");
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_node_members_run_member ON node_members(node_run_id, member_id)");
    db.run("CREATE TABLE IF NOT EXISTS node_events (id INTEGER PRIMARY KEY AUTOINCREMENT, node_run_id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_events_type ON node_events(type)");
    db.run("CREATE TABLE IF NOT EXISTS node_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, node_run_id TEXT NOT NULL, namespace TEXT, entry_type TEXT, entry_id TEXT, summary TEXT, source_member_id TEXT, confidence REAL, provenance_json TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_memory_run ON node_memory(node_run_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_memory_entry_id ON node_memory(entry_id) WHERE entry_id IS NOT NULL");
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_node_memory_run_entry ON node_memory(node_run_id, entry_id) WHERE entry_id IS NOT NULL");
    return;
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS node_runs (
      id                 TEXT PRIMARY KEY,
      node_name          TEXT NOT NULL,
      status             TEXT NOT NULL,
      coordinator_job_id TEXT,
      started_at_ms      INTEGER,
      updated_at_ms      INTEGER NOT NULL,
      waiting_on         TEXT,
      error              TEXT,
      memory_namespace   TEXT,
      status_json        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_runs_status ON node_runs(status);

    CREATE TABLE IF NOT EXISTS node_members (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      node_run_id  TEXT NOT NULL,
      member_id    TEXT NOT NULL,
      job_id       TEXT,
      specialist   TEXT NOT NULL,
      model        TEXT,
      role         TEXT,
      status       TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      generation   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_node_members_run ON node_members(node_run_id);
    CREATE INDEX IF NOT EXISTS idx_node_members_job ON node_members(job_id) WHERE job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_node_members_run_member ON node_members(node_run_id, member_id);

    CREATE TABLE IF NOT EXISTS node_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      node_run_id  TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      t            INTEGER NOT NULL,
      type         TEXT NOT NULL,
      event_json   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_node_events_run_seq ON node_events(node_run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_node_events_run_t ON node_events(node_run_id, t, seq, id);
    CREATE INDEX IF NOT EXISTS idx_node_events_type ON node_events(type);

    CREATE TABLE IF NOT EXISTS node_memory (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      node_run_id      TEXT NOT NULL,
      namespace        TEXT,
      entry_type       TEXT,
      entry_id         TEXT,
      summary          TEXT,
      source_member_id TEXT,
      confidence       REAL,
      provenance_json  TEXT,
      created_at_ms    INTEGER,
      updated_at_ms    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_node_memory_run ON node_memory(node_run_id);
    CREATE INDEX IF NOT EXISTS idx_node_memory_entry_id ON node_memory(entry_id) WHERE entry_id IS NOT NULL;

    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (4, strftime('%s', 'now') * 1000);
  `);
}
function initSchema(db) {
  enforceWalMode(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (1, strftime('%s', 'now') * 1000);

    -- Ensure specialist_jobs exists with at least the base columns so the
    -- migration INSERT below can always SELECT from it.
    CREATE TABLE IF NOT EXISTS specialist_jobs (
      job_id       TEXT PRIMARY KEY,
      specialist   TEXT NOT NULL,
      status_json  TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS specialist_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      specialist   TEXT NOT NULL,
      bead_id      TEXT,
      t            INTEGER NOT NULL,
      type         TEXT NOT NULL,
      event_json   TEXT NOT NULL
    );
    -- seq-dependent indexes are created/maintained by migrateToV6 to handle
    -- existing DBs where specialist_events was created without the seq column.
    CREATE INDEX IF NOT EXISTS idx_specialist_events_type ON specialist_events(type);

    CREATE TABLE IF NOT EXISTS specialist_results (
      job_id        TEXT PRIMARY KEY,
      output        TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories_cache (
      memory_key           TEXT PRIMARY KEY,
      memory_value         TEXT NOT NULL,
      updated_at_ms        INTEGER NOT NULL,
      last_accessed_at_ms  INTEGER,
      access_count         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memories_cache_meta (
      singleton_key    INTEGER PRIMARY KEY CHECK (singleton_key = 1),
      last_sync_at_ms  INTEGER NOT NULL,
      memory_count     INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key,
      content,
      tokenize='porter ascii'
    );
  `);
  const specialistJobsColumns = new Set(db.query("PRAGMA table_info(specialist_jobs)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  const missingSpecialistJobsColumns = [
    { name: "worktree_column", definition: "TEXT" },
    { name: "bead_id", definition: "TEXT" },
    { name: "node_id", definition: "TEXT" },
    { name: "chain_kind", definition: "TEXT NOT NULL DEFAULT 'prep'" },
    { name: "chain_id", definition: "TEXT" },
    { name: "chain_root_job_id", definition: "TEXT" },
    { name: "chain_root_bead_id", definition: "TEXT" },
    { name: "epic_id", definition: "TEXT" },
    { name: "status", definition: "TEXT NOT NULL DEFAULT 'starting'" },
    { name: "last_output", definition: "TEXT" },
    { name: "startup_payload_json", definition: "TEXT" }
  ].filter(({ name }) => !specialistJobsColumns.has(name));
  for (const missingColumn of missingSpecialistJobsColumns) {
    db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${missingColumn.name} ${missingColumn.definition}`);
  }
  const shouldRebuildSpecialistJobs = missingSpecialistJobsColumns.length > 0;
  if (shouldRebuildSpecialistJobs) {
    db.run(`
      CREATE TABLE IF NOT EXISTS specialist_jobs_new (
        job_id          TEXT PRIMARY KEY,
        specialist      TEXT NOT NULL,
        worktree_column TEXT,
        bead_id         TEXT,
        node_id         TEXT,
        chain_kind      TEXT NOT NULL DEFAULT 'prep',
        chain_id        TEXT,
        chain_root_job_id TEXT,
        chain_root_bead_id TEXT,
        epic_id         TEXT,
        status          TEXT NOT NULL,
        status_json     TEXT NOT NULL,
        updated_at_ms   INTEGER NOT NULL,
        last_output     TEXT,
        startup_payload_json TEXT
      );
      INSERT OR IGNORE INTO specialist_jobs_new
        SELECT
          job_id,
          specialist,
          worktree_column,
          bead_id,
          node_id,
          COALESCE(chain_kind, CASE WHEN chain_id IS NOT NULL OR worktree_column IS NOT NULL THEN 'chain' ELSE 'prep' END),
          chain_id,
          COALESCE(chain_root_job_id, chain_id),
          chain_root_bead_id,
          epic_id,
          COALESCE(status, JSON_EXTRACT(status_json, '$.status'), 'starting'),
          status_json,
          updated_at_ms,
          last_output,
          startup_payload_json
        FROM specialist_jobs;
      DROP TABLE IF EXISTS specialist_jobs;
      ALTER TABLE specialist_jobs_new RENAME TO specialist_jobs;
    `);
  }
  migrateToV2(db);
  migrateToV3(db);
  migrateToV4(db);
  migrateToV5(db);
  migrateToV6(db);
  migrateToV7(db);
  migrateToV8(db);
  migrateToV9(db);
  migrateToV10(db);
  migrateToV11(db);
  migrateToV12(db);
  migrateToV13(db);
  migrateToV14(db);
  migrateToV15(db);
  verifyWalMode(db);
}
function migrateToV13(db) {
  const hasV13 = db.query("SELECT 1 FROM schema_version WHERE version = 13 LIMIT 1").get();
  const specialistJobsColumns = new Set(db.query("PRAGMA table_info(specialist_jobs)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  for (const column of [
    { name: "pr_url", definition: "TEXT" },
    { name: "pr_head_sha", definition: "TEXT" },
    { name: "pr_state", definition: "TEXT" },
    { name: "pr_merge_state", definition: "TEXT" },
    { name: "pr_classification", definition: "TEXT" },
    { name: "pr_base_ref", definition: "TEXT" },
    { name: "pr_base_sha", definition: "TEXT" },
    { name: "pr_drift_checked_at_ms", definition: "INTEGER" },
    { name: "base_sha_pinned", definition: "TEXT" },
    { name: "base_sha_pinned_at_ms", definition: "INTEGER" }
  ]) {
    if (!specialistJobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
  if (hasV13) {
    return;
  }
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (13, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV14(db) {
  const hasV14 = db.query("SELECT 1 FROM schema_version WHERE version = 14 LIMIT 1").get();
  db.run(`
    CREATE TABLE IF NOT EXISTS branch_integration_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      t                 INTEGER NOT NULL,
      schema_version    TEXT NOT NULL,
      source_job_id     TEXT NOT NULL,
      source_branch     TEXT NOT NULL,
      source_worktree   TEXT NOT NULL,
      target_role       TEXT,
      target_branch     TEXT NOT NULL,
      target_worktree   TEXT NOT NULL,
      status            TEXT NOT NULL,
      commit_sha        TEXT NOT NULL,
      event_json        TEXT NOT NULL
    );
  `);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_integration_source_commit ON branch_integration_events(source_branch, commit_sha)");
  db.run("CREATE INDEX IF NOT EXISTS idx_branch_integration_target ON branch_integration_events(target_branch, t)");
  db.run("CREATE INDEX IF NOT EXISTS idx_branch_integration_source_job ON branch_integration_events(source_job_id, t)");
  if (hasV14)
    return;
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (14, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV15(db) {
  const hasV15 = db.query("SELECT 1 FROM schema_version WHERE version = 15 LIMIT 1").get();
  const jobsColumns = new Set(db.query("PRAGMA table_info(specialist_jobs)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  for (const column of [
    { name: "participant_id", definition: "TEXT" },
    { name: "pi_session_id", definition: "TEXT" },
    { name: "workspace_id", definition: "TEXT" },
    { name: "attempt_no", definition: "INTEGER DEFAULT 0" },
    { name: "attempt_id", definition: "TEXT" }
  ]) {
    if (!jobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
  const eventsColumns = new Set(db.query("PRAGMA table_info(specialist_events)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  if (!eventsColumns.has("attempt_id")) {
    db.run("ALTER TABLE specialist_events ADD COLUMN attempt_id TEXT");
  }
  const forensicColumns = new Set(db.query("PRAGMA table_info(specialist_forensic_events)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  if (!forensicColumns.has("attempt_id")) {
    db.run("ALTER TABLE specialist_forensic_events ADD COLUMN attempt_id TEXT");
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_participant ON specialist_jobs(participant_id) WHERE participant_id IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_pi_session ON specialist_jobs(pi_session_id) WHERE pi_session_id IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON specialist_jobs(workspace_id) WHERE workspace_id IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_specialist_events_job_attempt ON specialist_events(job_id, attempt_id, seq) WHERE attempt_id IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_forensic_events_job_attempt ON specialist_forensic_events(job_id, attempt_id, seq) WHERE attempt_id IS NOT NULL");
  if (hasV15)
    return;
  const backfill = db.transaction(() => {
    db.run(`
      UPDATE specialist_jobs
      SET pi_session_id = NULLIF(JSON_EXTRACT(status_json, '$.session_id'), '')
    `);
    db.run(`
      UPDATE specialist_jobs
      SET participant_id = 'specialist::' || COALESCE(NULLIF(TRIM(specialist), ''), '<unknown>')
    `);
    db.run(`
      UPDATE specialist_jobs
      SET attempt_no = 0
      WHERE attempt_no IS NULL
    `);
    const worktreeRows = db.query(`
      SELECT job_id, worktree_column
      FROM specialist_jobs
      WHERE worktree_column IS NOT NULL AND worktree_column != ''
    `).all();
    const workspaceStmt = db.query("UPDATE specialist_jobs SET workspace_id = ? WHERE job_id = ?");
    for (const row of worktreeRows) {
      if (!row.job_id || !row.worktree_column)
        continue;
      workspaceStmt.run(normalizeWorkspacePath(row.worktree_column), row.job_id);
    }
    db.run(`
      UPDATE specialist_forensic_events AS forensic
      SET participant_id = 'specialist::' || COALESCE(
        NULLIF(TRIM(forensic.participant_role), ''),
        NULLIF(TRIM((
          SELECT jobs.specialist
          FROM specialist_jobs AS jobs
          WHERE jobs.job_id = forensic.job_id
          LIMIT 1
        )), ''),
        '<unknown>'
      )
      WHERE forensic.participant_kind = 'specialist'
    `);
    db.run(`
      INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
        VALUES (15, strftime('%s', 'now') * 1000);
    `);
  });
  backfill();
}
function migrateToV5(db) {
  const hasV5 = db.query("SELECT 1 FROM schema_version WHERE version = 5 LIMIT 1").get();
  if (!hasV5) {
    const nodeMemberColumns = new Set(db.query("PRAGMA table_info(node_members)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
    if (!nodeMemberColumns.has("generation")) {
      db.run("ALTER TABLE node_members ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    }
    db.run(`
      INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
        VALUES (5, strftime('%s', 'now') * 1000);
    `);
  }
}
function migrateToV6(db) {
  const hasV6 = db.query("SELECT 1 FROM schema_version WHERE version = 6 LIMIT 1").get();
  if (hasV6) {
    db.run("CREATE INDEX IF NOT EXISTS idx_specialist_events_job_seq ON specialist_events(job_id, seq)");
    db.run("CREATE INDEX IF NOT EXISTS idx_specialist_events_job_t ON specialist_events(job_id, t, seq, id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_events_run_seq ON node_events(node_run_id, seq)");
    db.run("CREATE INDEX IF NOT EXISTS idx_node_events_run_t ON node_events(node_run_id, t, seq, id)");
    return;
  }
  const specialistEventColumns = new Set(db.query("PRAGMA table_info(specialist_events)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  if (!specialistEventColumns.has("seq")) {
    db.run("ALTER TABLE specialist_events ADD COLUMN seq INTEGER");
  }
  db.run(`
    UPDATE specialist_events
    SET seq = (
      SELECT COUNT(*)
      FROM specialist_events prior
      WHERE prior.job_id = specialist_events.job_id
        AND prior.id <= specialist_events.id
    )
    WHERE seq IS NULL OR seq <= 0
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_specialist_events_job_seq ON specialist_events(job_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS idx_specialist_events_job_t ON specialist_events(job_id, t, seq, id)");
  const nodeEventColumns = new Set(db.query("PRAGMA table_info(node_events)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  if (!nodeEventColumns.has("seq")) {
    db.run("ALTER TABLE node_events ADD COLUMN seq INTEGER");
  }
  db.run(`
    UPDATE node_events
    SET seq = (
      SELECT COUNT(*)
      FROM node_events prior
      WHERE prior.node_run_id = node_events.node_run_id
        AND prior.id <= node_events.id
    )
    WHERE seq IS NULL OR seq <= 0
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_node_events_run_seq ON node_events(node_run_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS idx_node_events_run_t ON node_events(node_run_id, t, seq, id)");
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (6, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV7(db) {
  const hasV7 = db.query("SELECT 1 FROM schema_version WHERE version = 7 LIMIT 1").get();
  const nodeRunColumns = new Set(db.query("PRAGMA table_info(node_runs)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  for (const column of [
    { name: "pr_number", definition: "INTEGER" },
    { name: "pr_url", definition: "TEXT" },
    { name: "pr_head_sha", definition: "TEXT" },
    { name: "gate_results", definition: "TEXT" },
    { name: "completion_strategy", definition: "TEXT" }
  ]) {
    if (!nodeRunColumns.has(column.name)) {
      db.run(`ALTER TABLE node_runs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
  const nodeMemberColumns = new Set(db.query("PRAGMA table_info(node_members)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  for (const column of [
    { name: "worktree_path", definition: "TEXT" },
    { name: "parent_member_id", definition: "TEXT" },
    { name: "replaced_member_id", definition: "TEXT" },
    { name: "phase_id", definition: "TEXT" }
  ]) {
    if (!nodeMemberColumns.has(column.name)) {
      db.run(`ALTER TABLE node_members ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
  if (hasV7) {
    return;
  }
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (7, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV8(db) {
  const hasV8 = db.query("SELECT 1 FROM schema_version WHERE version = 8 LIMIT 1").get();
  const specialistJobsColumns = new Set(db.query("PRAGMA table_info(specialist_jobs)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  for (const column of [
    { name: "chain_id", definition: "TEXT" },
    { name: "epic_id", definition: "TEXT" }
  ]) {
    if (!specialistJobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_chain ON specialist_jobs(chain_id) WHERE chain_id IS NOT NULL");
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_epic ON specialist_jobs(epic_id) WHERE epic_id IS NOT NULL");
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_bead_specialist ON specialist_jobs(bead_id, specialist) WHERE bead_id IS NOT NULL AND status IN ('starting', 'running')");
  db.run(`
    CREATE TABLE IF NOT EXISTS epic_runs (
      epic_id         TEXT PRIMARY KEY,
      status          TEXT NOT NULL,
      status_json     TEXT NOT NULL,
      updated_at_ms   INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS epic_chain_membership (
      chain_id            TEXT PRIMARY KEY,
      epic_id             TEXT NOT NULL,
      chain_root_bead_id  TEXT,
      chain_root_job_id   TEXT,
      updated_at_ms       INTEGER NOT NULL
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_epic_runs_status ON epic_runs(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_epic_chain_membership_epic ON epic_chain_membership(epic_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_epic_chain_membership_bead ON epic_chain_membership(chain_root_bead_id) WHERE chain_root_bead_id IS NOT NULL");
  if (hasV8) {
    return;
  }
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (8, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV9(db) {
  const hasV9 = db.query("SELECT 1 FROM schema_version WHERE version = 9 LIMIT 1").get();
  const specialistJobsColumns = new Set(db.query("PRAGMA table_info(specialist_jobs)").all().map((column) => column.name).filter((name) => typeof name === "string" && name.length > 0));
  for (const column of [
    { name: "chain_kind", definition: "TEXT NOT NULL DEFAULT 'prep'" },
    { name: "chain_root_job_id", definition: "TEXT" },
    { name: "chain_root_bead_id", definition: "TEXT" }
  ]) {
    if (!specialistJobsColumns.has(column.name)) {
      db.run(`ALTER TABLE specialist_jobs ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
  db.run(`
    UPDATE specialist_jobs
    SET chain_kind = CASE
      WHEN chain_id IS NOT NULL OR worktree_column IS NOT NULL THEN 'chain'
      ELSE 'prep'
    END
    WHERE chain_kind IS NULL OR chain_kind = ''
  `);
  db.run(`
    UPDATE specialist_jobs
    SET chain_root_job_id = COALESCE(chain_root_job_id, chain_id)
    WHERE chain_kind = 'chain' AND chain_root_job_id IS NULL
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_chain_kind ON specialist_jobs(chain_kind)");
  db.run("CREATE INDEX IF NOT EXISTS idx_jobs_chain_root_job ON specialist_jobs(chain_root_job_id) WHERE chain_root_job_id IS NOT NULL");
  if (hasV9) {
    return;
  }
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (9, strftime('%s', 'now') * 1000);
  `);
}
function migrateToV10(db) {
  const hasV10 = db.query("SELECT 1 FROM schema_version WHERE version = 10 LIMIT 1").get();
  db.run(`
    CREATE TABLE IF NOT EXISTS memories_cache (
      memory_key           TEXT PRIMARY KEY,
      memory_value         TEXT NOT NULL,
      updated_at_ms        INTEGER NOT NULL,
      last_accessed_at_ms  INTEGER,
      access_count         INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memories_cache_meta (
      singleton_key    INTEGER PRIMARY KEY CHECK (singleton_key = 1),
      last_sync_at_ms  INTEGER NOT NULL,
      memory_count     INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key,
      content,
      tokenize='porter ascii'
    );
  `);
  if (hasV10) {
    return;
  }
  db.run(`
    INSERT OR IGNORE INTO schema_version (version, applied_at_ms)
      VALUES (10, strftime('%s', 'now') * 1000);
  `);
}
var STALE_CLAIM_AGE_MS = 60000;
function defaultIsPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function claimJobStartWithStore(store, status, event, options = {}) {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const nowMs = options.nowMs ?? Date.now;
  const staleAgeMs = options.staleClaimAgeMs ?? STALE_CLAIM_AGE_MS;
  return withRetry(() => store.transaction(() => {
    const existing = store.findActiveJob(status.bead_id ?? null, status.specialist);
    if (existing?.job_id && existing.job_id !== status.id) {
      const updatedAtMs = existing.updated_at_ms ?? 0;
      const isStale = updatedAtMs > 0 && nowMs() - updatedAtMs > staleAgeMs && !isPidAlive(existing.pid);
      if (isStale && store.cancelStaleClaim) {
        store.cancelStaleClaim(existing.job_id);
      } else {
        return { ok: false, existingJobId: existing.job_id, existingStatus: existing.status ?? "starting" };
      }
    }
    store.writeStatusRow(status);
    store.writeEventRow(status.id, status.specialist, status.bead_id, event);
    return { ok: true };
  }), "claimJobStart");
}

class SqliteClient {
  db;
  dbPath;
  constructor(dbPath) {
    this.dbPath = dbPath;
    const Ctor = loadBunDatabase();
    this.db = new Ctor(dbPath);
    this.db.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    this.db.run("PRAGMA journal_mode=WAL");
  }
  writeStatusRow(status, lastOutput) {
    const statusJson = JSON.stringify(status);
    const workspaceId = normalizeWorkspacePath(status.worktree_path);
    const piSessionId = status.session_id ?? null;
    const participantId = deriveParticipantId({ participant_role: status.specialist });
    const attemptId = `${status.id}::attempt::1`;
    this.db.run(`
      INSERT INTO specialist_jobs (job_id, specialist, worktree_column, bead_id, node_id, chain_kind, chain_id, chain_root_job_id, chain_root_bead_id, epic_id, status, status_json, updated_at_ms, last_output, startup_payload_json, participant_id, pi_session_id, workspace_id, attempt_no, attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        specialist = excluded.specialist,
        worktree_column = excluded.worktree_column,
        bead_id = excluded.bead_id,
        node_id = excluded.node_id,
        chain_kind = excluded.chain_kind,
        chain_id = excluded.chain_id,
        chain_root_job_id = excluded.chain_root_job_id,
        chain_root_bead_id = excluded.chain_root_bead_id,
        epic_id = excluded.epic_id,
        status = excluded.status,
        status_json = excluded.status_json,
        updated_at_ms = excluded.updated_at_ms,
        last_output = COALESCE(excluded.last_output, specialist_jobs.last_output),
        startup_payload_json = COALESCE(excluded.startup_payload_json, specialist_jobs.startup_payload_json),
        participant_id = excluded.participant_id,
        pi_session_id = excluded.pi_session_id,
        workspace_id = excluded.workspace_id;
    `, [
      status.id,
      status.specialist,
      status.worktree_path ?? null,
      status.bead_id ?? null,
      status.node_id ?? null,
      status.chain_kind ?? (status.chain_id ? "chain" : "prep"),
      status.chain_id ?? null,
      status.chain_root_job_id ?? null,
      status.chain_root_bead_id ?? null,
      status.epic_id ?? null,
      status.status,
      statusJson,
      Date.now(),
      lastOutput ?? null,
      status.startup_payload_json ?? null,
      participantId,
      piSessionId,
      workspaceId,
      attemptId
    ]);
  }
  writeEpicRunRow(epic) {
    this.db.run(`
      INSERT INTO epic_runs (epic_id, status, status_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(epic_id) DO UPDATE SET
        status = excluded.status,
        status_json = excluded.status_json,
        updated_at_ms = excluded.updated_at_ms;
    `, [epic.epic_id, epic.status, epic.status_json, epic.updated_at_ms]);
  }
  writeEpicChainMembershipRow(chain) {
    this.db.run(`
      INSERT INTO epic_chain_membership (chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chain_id) DO UPDATE SET
        epic_id = excluded.epic_id,
        chain_root_bead_id = excluded.chain_root_bead_id,
        chain_root_job_id = excluded.chain_root_job_id,
        updated_at_ms = excluded.updated_at_ms;
    `, [
      chain.chain_id,
      chain.epic_id,
      chain.chain_root_bead_id ?? null,
      chain.chain_root_job_id ?? null,
      chain.updated_at_ms
    ]);
  }
  getNextSpecialistEventSeq(jobId) {
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM specialist_events WHERE job_id = ?").get(jobId);
    return row?.next_seq ?? 1;
  }
  getNextForensicEventSeq(jobId) {
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM specialist_forensic_events WHERE job_id = ?").get(jobId);
    return row?.next_seq ?? 1;
  }
  getNextNodeEventSeq(nodeRunId) {
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM node_events WHERE node_run_id = ?").get(nodeRunId);
    return row?.next_seq ?? 1;
  }
  readJobAttempt(jobId) {
    const row = this.db.query("SELECT attempt_no, attempt_id FROM specialist_jobs WHERE job_id = ? LIMIT 1").get(jobId);
    if (!row)
      return null;
    const attemptNo = typeof row.attempt_no === "bigint" ? Number(row.attempt_no) : typeof row.attempt_no === "number" ? row.attempt_no : 0;
    return { attempt_no: attemptNo, attempt_id: typeof row.attempt_id === "string" ? row.attempt_id : null };
  }
  writeEventRow(jobId, specialist, beadId, event) {
    const seq = typeof event.seq === "number" && event.seq > 0 ? event.seq : this.getNextSpecialistEventSeq(jobId);
    const sequencedEvent = { ...event, seq };
    const eventJson = JSON.stringify(sequencedEvent);
    const current = this.readJobAttempt(jobId);
    let attemptId;
    if (isRetryStartEvent(event)) {
      const nextNo = (current?.attempt_no ?? 0) + 1;
      attemptId = buildAttemptId(jobId, nextNo);
      if (current) {
        this.db.run("UPDATE specialist_jobs SET attempt_no = ?, attempt_id = ?, updated_at_ms = ? WHERE job_id = ?", [nextNo, attemptId, Date.now(), jobId]);
      }
    } else if (current && current.attempt_no > 0) {
      attemptId = current.attempt_id ?? buildAttemptId(jobId, current.attempt_no);
    } else if (!current) {
      attemptId = buildAttemptId(jobId, 1);
    } else {
      attemptId = null;
    }
    this.db.run(`
      INSERT INTO specialist_events (job_id, seq, specialist, bead_id, t, type, event_json, attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [jobId, seq, specialist, beadId ?? null, event.t, event.type, eventJson, attemptId]);
    this.writeForensicEventRow(jobId, specialist, beadId, sequencedEvent, attemptId);
  }
  writeForensicEventRow(jobId, specialist, beadId, event, attemptId) {
    const context = this.readForensicContext(jobId);
    const forensicEvent = forensicEventFromTimelineEvent(event, {
      jobId,
      specialist,
      beadId: context.beadId ?? beadId,
      nodeId: context.nodeId,
      repo: context.repo,
      serviceComponent: "runtime",
      model: context.model,
      backend: context.backend,
      chainKind: context.chainKind,
      chainId: context.chainId,
      chainRootJobId: context.chainRootJobId,
      chainRootBeadId: context.chainRootBeadId,
      epicId: context.epicId,
      sessionId: context.sessionId,
      attemptId: attemptId ?? context.attemptId,
      piSessionId: context.piSessionId ?? context.sessionId,
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      parentJobId: context.parentJobId,
      spawnOrigin: context.spawnOrigin,
      rootRuntimeOrigin: context.rootRuntimeOrigin
    });
    this.insertForensicEventRow(jobId, event.seq, forensicEvent, attemptId);
  }
  readForensicContext(jobId) {
    const row = this.db.query(`
      SELECT bead_id, node_id, chain_kind, chain_id, chain_root_job_id, chain_root_bead_id, epic_id,
             participant_id, pi_session_id, workspace_id, attempt_id, status_json
      FROM specialist_jobs
      WHERE job_id = ?
      LIMIT 1
    `).get(jobId);
    const statusJson = parseJsonRecord(typeof row?.status_json === "string" ? row.status_json : undefined);
    const columnSession = typeof row?.pi_session_id === "string" ? row.pi_session_id : undefined;
    return {
      beadId: typeof row?.bead_id === "string" ? row.bead_id : undefined,
      nodeId: typeof row?.node_id === "string" ? row.node_id : undefined,
      repo: typeof statusJson.repo === "string" ? statusJson.repo : undefined,
      model: typeof statusJson.model === "string" ? statusJson.model : undefined,
      backend: typeof statusJson.backend === "string" ? statusJson.backend : undefined,
      chainKind: typeof row?.chain_kind === "string" ? row.chain_kind : undefined,
      chainId: typeof row?.chain_id === "string" ? row.chain_id : undefined,
      chainRootJobId: typeof row?.chain_root_job_id === "string" ? row.chain_root_job_id : undefined,
      chainRootBeadId: typeof row?.chain_root_bead_id === "string" ? row.chain_root_bead_id : undefined,
      epicId: typeof row?.epic_id === "string" ? row.epic_id : undefined,
      sessionId: columnSession ?? (typeof statusJson.session_id === "string" ? statusJson.session_id : undefined),
      attemptId: typeof row?.attempt_id === "string" ? row.attempt_id : undefined,
      piSessionId: columnSession ?? (typeof statusJson.session_id === "string" ? statusJson.session_id : undefined),
      workspaceId: typeof row?.workspace_id === "string" ? row.workspace_id : undefined,
      participantId: typeof row?.participant_id === "string" ? row.participant_id : undefined,
      conversationId: typeof statusJson.conversation_id === "string" ? statusJson.conversation_id : undefined,
      traceId: typeof statusJson.trace_id === "string" ? statusJson.trace_id : undefined,
      spanId: typeof statusJson.span_id === "string" ? statusJson.span_id : undefined,
      parentSpanId: typeof statusJson.parent_span_id === "string" ? statusJson.parent_span_id : undefined,
      parentJobId: typeof statusJson.parent_job_id === "string" ? statusJson.parent_job_id : undefined,
      spawnOrigin: statusJson.spawn_origin,
      rootRuntimeOrigin: statusJson.root_runtime_origin
    };
  }
  insertForensicEventRow(jobId, seq, forensicEvent, attemptId) {
    const columnAttemptId = attemptId ?? (typeof forensicEvent.correlation.attempt_id === "string" ? forensicEvent.correlation.attempt_id : null);
    this.db.run(`
      INSERT INTO specialist_forensic_events (
        job_id, seq, t, schema_version, event_family, event_name,
        participant_kind, participant_role, participant_id, redaction_status, event_json, attempt_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      jobId,
      seq,
      forensicEvent.t_unix_ms,
      forensicEvent.schema_version,
      forensicEvent.event_family,
      forensicEvent.event_name,
      forensicEvent.resource.participant_kind ?? null,
      forensicEvent.resource.participant_role ?? null,
      typeof forensicEvent.correlation.participant_id === "string" ? forensicEvent.correlation.participant_id : null,
      forensicEvent.redaction.status,
      JSON.stringify(forensicEvent),
      columnAttemptId
    ]);
  }
  findActiveJob(beadId, specialist) {
    return this.db.query(`
      SELECT
        job_id,
        status,
        updated_at_ms,
        CAST(JSON_EXTRACT(status_json, '$.pid') AS INTEGER) AS pid
      FROM specialist_jobs
      WHERE bead_id = ?
        AND specialist = ?
        AND status IN ('starting', 'running', 'waiting')
      ORDER BY updated_at_ms DESC
      LIMIT 1
    `).get(beadId, specialist);
  }
  claimJobStart(status, event) {
    return claimJobStartWithStore({
      transaction: (callback) => this.db.transaction(callback)(),
      findActiveJob: (beadId, specialist) => this.findActiveJob(beadId, specialist),
      writeStatusRow: (nextStatus) => this.writeStatusRow(nextStatus),
      writeEventRow: (jobId, specialist, beadId, nextEvent) => this.writeEventRow(jobId, specialist, beadId, nextEvent),
      cancelStaleClaim: (jobId) => {
        const nowMs = Date.now();
        this.db.run(`
            UPDATE specialist_jobs
            SET status = 'cancelled',
                status_json = JSON_PATCH(status_json, JSON_OBJECT('status', 'cancelled', 'cancelled_reason', 'orphan-claim-stale')),
                updated_at_ms = ?
            WHERE job_id = ?
          `, [nowMs, jobId]);
      }
    }, status, event);
  }
  writeResultRow(jobId, output) {
    this.db.run(`
      INSERT INTO specialist_results (job_id, output, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        output = excluded.output,
        updated_at_ms = excluded.updated_at_ms;
    `, [jobId, output, Date.now()]);
  }
  writeNodeRunRow(nodeRun) {
    this.db.run(`
      INSERT INTO node_runs (
        id,
        node_name,
        status,
        coordinator_job_id,
        started_at_ms,
        updated_at_ms,
        waiting_on,
        error,
        memory_namespace,
        status_json,
        pr_number,
        pr_url,
        pr_head_sha,
        gate_results,
        completion_strategy
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_name = excluded.node_name,
        status = excluded.status,
        coordinator_job_id = excluded.coordinator_job_id,
        started_at_ms = excluded.started_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        waiting_on = excluded.waiting_on,
        error = excluded.error,
        memory_namespace = excluded.memory_namespace,
        status_json = excluded.status_json,
        pr_number = excluded.pr_number,
        pr_url = excluded.pr_url,
        pr_head_sha = excluded.pr_head_sha,
        gate_results = excluded.gate_results,
        completion_strategy = excluded.completion_strategy;
    `, [
      nodeRun.id,
      nodeRun.node_name,
      nodeRun.status,
      nodeRun.coordinator_job_id ?? null,
      nodeRun.started_at_ms ?? null,
      nodeRun.updated_at_ms,
      nodeRun.waiting_on ?? null,
      nodeRun.error ?? null,
      nodeRun.memory_namespace ?? null,
      nodeRun.status_json,
      nodeRun.pr_number ?? null,
      nodeRun.pr_url ?? null,
      nodeRun.pr_head_sha ?? null,
      nodeRun.gate_results ?? null,
      nodeRun.completion_strategy ?? null
    ]);
  }
  writeNodeMemberRow(member) {
    this.db.run(`
      INSERT INTO node_members (
        node_run_id,
        member_id,
        job_id,
        specialist,
        model,
        role,
        status,
        enabled,
        generation,
        worktree_path,
        parent_member_id,
        replaced_member_id,
        phase_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_run_id, member_id) DO UPDATE SET
        job_id = excluded.job_id,
        specialist = excluded.specialist,
        model = excluded.model,
        role = excluded.role,
        status = excluded.status,
        enabled = excluded.enabled,
        generation = excluded.generation,
        worktree_path = excluded.worktree_path,
        parent_member_id = excluded.parent_member_id,
        replaced_member_id = excluded.replaced_member_id,
        phase_id = excluded.phase_id;
    `, [
      member.node_run_id,
      member.member_id,
      member.job_id ?? null,
      member.specialist,
      member.model ?? null,
      member.role ?? null,
      member.status,
      member.enabled === undefined ? 1 : member.enabled ? 1 : 0,
      member.generation ?? 0,
      member.worktree_path ?? null,
      member.parent_member_id ?? null,
      member.replaced_member_id ?? null,
      member.phase_id ?? null
    ]);
  }
  writeNodeEventRow(nodeRunId, t, type, eventJson) {
    const seq = this.getNextNodeEventSeq(nodeRunId);
    const payload = typeof eventJson === "object" && eventJson !== null ? { ...eventJson, seq } : { value: eventJson, seq };
    this.db.run(`
      INSERT INTO node_events (node_run_id, seq, t, type, event_json)
      VALUES (?, ?, ?, ?, ?)
    `, [nodeRunId, seq, t, type, JSON.stringify(payload)]);
  }
  writeNodeMemoryRow(entry) {
    const now = Date.now();
    const createdAtMs = entry.created_at_ms ?? now;
    const updatedAtMs = entry.updated_at_ms ?? now;
    if (entry.entry_id) {
      this.db.run(`
        INSERT INTO node_memory (
          node_run_id,
          namespace,
          entry_type,
          entry_id,
          summary,
          source_member_id,
          confidence,
          provenance_json,
          created_at_ms,
          updated_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_run_id, entry_id) DO UPDATE SET
          namespace = excluded.namespace,
          entry_type = excluded.entry_type,
          summary = excluded.summary,
          source_member_id = excluded.source_member_id,
          confidence = excluded.confidence,
          provenance_json = excluded.provenance_json,
          created_at_ms = excluded.created_at_ms,
          updated_at_ms = excluded.updated_at_ms
      `, [
        entry.node_run_id,
        entry.namespace ?? null,
        entry.entry_type ?? null,
        entry.entry_id,
        entry.summary ?? null,
        entry.source_member_id ?? null,
        entry.confidence ?? null,
        entry.provenance_json ?? null,
        createdAtMs,
        updatedAtMs
      ]);
      return;
    }
    this.db.run(`
      INSERT INTO node_memory (
        node_run_id,
        namespace,
        entry_type,
        entry_id,
        summary,
        source_member_id,
        confidence,
        provenance_json,
        created_at_ms,
        updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.node_run_id,
      entry.namespace ?? null,
      entry.entry_type ?? null,
      null,
      entry.summary ?? null,
      entry.source_member_id ?? null,
      entry.confidence ?? null,
      entry.provenance_json ?? null,
      createdAtMs,
      updatedAtMs
    ]);
  }
  upsertStatus(status) {
    withRetry(() => {
      this.writeStatusRow(status);
    }, "upsertStatus");
  }
  markSpecialistJobCancelled(jobId, reason) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        const nowMs = Date.now();
        this.db.run(`
          UPDATE specialist_jobs
          SET status = 'cancelled',
              status_json = JSON_PATCH(status_json, JSON_OBJECT('status', 'cancelled', 'cancelled_reason', ?)),
              updated_at_ms = ?
          WHERE job_id = ?
        `, [reason, nowMs, jobId]);
      });
      transaction();
    }, "markSpecialistJobCancelled");
  }
  upsertEpicRun(epic) {
    withRetry(() => {
      this.writeEpicRunRow(epic);
    }, "upsertEpicRun");
  }
  upsertEpicChainMembership(chain) {
    withRetry(() => {
      this.writeEpicChainMembershipRow(chain);
    }, "upsertEpicChainMembership");
  }
  upsertStatusWithEvent(status, event) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeStatusRow(status);
        this.writeEventRow(status.id, status.specialist, status.bead_id, event);
      });
      transaction();
    }, "upsertStatusWithEvent");
  }
  upsertStatusWithEventAndResult(status, event, output) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeStatusRow(status, output);
        this.writeEventRow(status.id, status.specialist, status.bead_id, event);
        this.writeResultRow(status.id, output);
      });
      transaction();
    }, "upsertStatusWithEventAndResult");
  }
  appendEvent(jobId, specialist, beadId, event) {
    withRetry(() => {
      this.writeEventRow(jobId, specialist, beadId, event);
    }, "appendEvent");
  }
  appendForensicEvent(jobId, specialist, beadId, forensicEvent) {
    withRetry(() => {
      const seq = typeof forensicEvent.seq === "number" && forensicEvent.seq > 0 ? forensicEvent.seq : this.getNextForensicEventSeq(jobId);
      this.insertForensicEventRow(jobId, seq, forensicEvent);
    }, "appendForensicEvent");
  }
  recordBranchIntegration(event) {
    withRetry(() => {
      this.db.run(`
        INSERT OR IGNORE INTO branch_integration_events (
          t, schema_version,
          source_job_id, source_branch, source_worktree,
          target_role, target_branch, target_worktree,
          status, commit_sha, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        event.t_unix_ms,
        event.schema_version,
        event.source.job_id,
        event.source.branch,
        event.source.worktree,
        event.target.role ?? null,
        event.target.branch,
        event.target.worktree,
        event.status,
        event.commit,
        JSON.stringify(event)
      ]);
    }, "recordBranchIntegration");
  }
  listBranchIntegrations(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.targetBranch) {
      clauses.push("target_branch = ?");
      params.push(filters.targetBranch);
    }
    if (filters.sourceJobId) {
      clauses.push("source_job_id = ?");
      params.push(filters.sourceJobId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit && filters.limit > 0 ? ` LIMIT ${Math.floor(filters.limit)}` : "";
    const rows = this.db.query(`SELECT id, t, event_json FROM branch_integration_events ${where} ORDER BY t DESC, id DESC${limit}`).all(...params);
    return rows.map((row) => ({
      id: row.id,
      t: row.t,
      event: JSON.parse(row.event_json)
    }));
  }
  upsertResult(jobId, output) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeResultRow(jobId, output);
        this.db.run(`
          UPDATE specialist_jobs SET last_output = ? WHERE job_id = ?
        `, [output, jobId]);
      });
      transaction();
    }, "upsertResult");
  }
  bootstrapNode(nodeRunId, nodeName, memoryNamespace) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        const now = Date.now();
        this.writeNodeRunRow({
          id: nodeRunId,
          node_name: nodeName,
          status: "created",
          started_at_ms: now,
          updated_at_ms: now,
          memory_namespace: memoryNamespace,
          status_json: JSON.stringify({ status: "created" })
        });
        this.writeNodeEventRow(nodeRunId, now, "node_created", { node_run_id: nodeRunId, node_name: nodeName });
        this.writeNodeEventRow(nodeRunId, now + 1, "node_started", { node_run_id: nodeRunId, node_name: nodeName });
      });
      transaction();
    }, "bootstrapNode");
  }
  upsertNodeRun(nodeRun) {
    withRetry(() => {
      this.writeNodeRunRow(nodeRun);
    }, "upsertNodeRun");
  }
  upsertNodeMember(member) {
    withRetry(() => {
      this.writeNodeMemberRow(member);
    }, "upsertNodeMember");
  }
  appendNodeEvent(nodeRunId, t, type, eventJson) {
    withRetry(() => {
      this.writeNodeEventRow(nodeRunId, t, type, eventJson);
    }, "appendNodeEvent");
  }
  upsertNodeMemory(entry) {
    withRetry(() => {
      this.writeNodeMemoryRow(entry);
    }, "upsertNodeMemory");
  }
  upsertNodeRunWithEvent(nodeRun, t, type, eventJson) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeNodeRunRow(nodeRun);
        this.writeNodeEventRow(nodeRun.id, t, type, eventJson);
      });
      transaction();
    }, "upsertNodeRunWithEvent");
  }
  upsertNodeMemberWithEvent(member, nodeRunId, t, type, eventJson) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeNodeMemberRow(member);
        this.writeNodeEventRow(nodeRunId, t, type, eventJson);
      });
      transaction();
    }, "upsertNodeMemberWithEvent");
  }
  upsertNodeMemoryWithEvent(entry, nodeRunId, t, type, eventJson) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.writeNodeMemoryRow(entry);
        this.writeNodeEventRow(nodeRunId, t, type, eventJson);
      });
      transaction();
    }, "upsertNodeMemoryWithEvent");
  }
  readNodeRun(nodeRunId) {
    return withRetry(() => {
      const row = this.db.query("SELECT * FROM node_runs WHERE id = ? LIMIT 1").get(nodeRunId);
      if (!row)
        return null;
      return {
        ...row,
        status: row.status
      };
    }, "readNodeRun");
  }
  listNodeRuns(filter) {
    return withRetry(() => {
      const query = filter?.status ? "SELECT * FROM node_runs WHERE status = ? ORDER BY updated_at_ms DESC" : "SELECT * FROM node_runs ORDER BY updated_at_ms DESC";
      const rows = filter?.status ? this.db.query(query).all(filter.status) : this.db.query(query).all();
      return rows.map((row) => ({
        ...row,
        status: row.status
      }));
    }, "listNodeRuns");
  }
  listNodeRunsByRef(partialRef, statuses) {
    return withRetry(() => {
      if (statuses.length === 0)
        return [];
      const placeholders = statuses.map(() => "?").join(", ");
      const query = `
        SELECT *
        FROM node_runs
        WHERE status IN (${placeholders})
          AND (id LIKE ? OR node_name LIKE ?)
        ORDER BY updated_at_ms DESC
      `;
      const prefix = `${partialRef}%`;
      const rows = this.db.query(query).all(...statuses, prefix, prefix);
      return rows.map((row) => ({
        ...row,
        status: row.status
      }));
    }, "listNodeRunsByRef");
  }
  listNodeRunsByStatuses(statuses) {
    return withRetry(() => {
      if (statuses.length === 0)
        return [];
      const placeholders = statuses.map(() => "?").join(", ");
      const query = `
        SELECT *
        FROM node_runs
        WHERE status IN (${placeholders})
        ORDER BY updated_at_ms DESC
      `;
      const rows = this.db.query(query).all(...statuses);
      return rows.map((row) => ({
        ...row,
        status: row.status
      }));
    }, "listNodeRunsByStatuses");
  }
  readNodeMembers(nodeRunId) {
    return withRetry(() => {
      const rows = this.db.query("SELECT * FROM node_members WHERE node_run_id = ? ORDER BY id ASC").all(nodeRunId);
      return rows.map((row) => ({
        node_run_id: row.node_run_id,
        member_id: row.member_id,
        job_id: row.job_id ?? undefined,
        specialist: row.specialist,
        model: row.model ?? undefined,
        role: row.role ?? undefined,
        status: row.status,
        enabled: row.enabled === undefined ? undefined : Boolean(row.enabled),
        generation: row.generation ?? 0,
        worktree_path: row.worktree_path ?? undefined,
        parent_member_id: row.parent_member_id ?? undefined,
        replaced_member_id: row.replaced_member_id ?? undefined,
        phase_id: row.phase_id ?? undefined
      }));
    }, "readNodeMembers");
  }
  readNodeEvents(nodeRunId, opts) {
    return withRetry(() => {
      const whereClauses = ["node_run_id = ?"];
      const params = [nodeRunId];
      if (opts?.type) {
        whereClauses.push("type = ?");
        params.push(opts.type);
      }
      let query = `
        SELECT id, seq, t, type, event_json
        FROM node_events
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY seq ASC, id ASC
      `;
      if (opts?.limit !== undefined) {
        query += " LIMIT ?";
        params.push(opts.limit);
      }
      return this.db.query(query).all(...params);
    }, "readNodeEvents");
  }
  readNodeMemory(nodeRunId, opts) {
    return withRetry(() => {
      const whereClauses = ["node_run_id = ?"];
      const params = [nodeRunId];
      if (opts?.namespace) {
        whereClauses.push("namespace = ?");
        params.push(opts.namespace);
      }
      if (opts?.entry_type) {
        whereClauses.push("entry_type = ?");
        params.push(opts.entry_type);
      }
      const query = `
        SELECT *
        FROM node_memory
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY created_at_ms ASC
      `;
      return this.db.query(query).all(...params);
    }, "readNodeMemory");
  }
  queryMemberContextHealth(jobId) {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT json_extract(event_json, '$.context_pct') AS context_pct
        FROM specialist_events
        WHERE job_id = ? AND type = 'turn_summary'
        ORDER BY seq DESC, id DESC
        LIMIT 1
      `).get(jobId);
      if (!row || row.context_pct === null || row.context_pct === undefined) {
        return null;
      }
      const contextPct = typeof row.context_pct === "number" ? row.context_pct : Number(row.context_pct);
      return Number.isFinite(contextPct) ? contextPct : null;
    }, "queryMemberContextHealth");
  }
  readStatus(jobId) {
    return withRetry(() => {
      const row = this.db.query("SELECT status_json FROM specialist_jobs WHERE job_id = ? LIMIT 1").get(jobId);
      if (!row?.status_json)
        return null;
      return JSON.parse(row.status_json);
    }, "readStatus");
  }
  listStatuses() {
    return withRetry(() => {
      const rows = this.db.query("SELECT status_json FROM specialist_jobs ORDER BY updated_at_ms DESC").all();
      const statuses = [];
      for (const row of rows) {
        if (!row.status_json)
          continue;
        try {
          statuses.push(JSON.parse(row.status_json));
        } catch {}
      }
      return statuses;
    }, "listStatuses");
  }
  readPrDriftState(jobId) {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT pr_url, pr_head_sha, pr_state, pr_merge_state, pr_classification,
               pr_base_ref, pr_base_sha, pr_drift_checked_at_ms,
               base_sha_pinned, base_sha_pinned_at_ms
        FROM specialist_jobs WHERE job_id = ? LIMIT 1
      `).get(jobId);
      if (!row)
        return null;
      const num = (v) => v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : null;
      const str = (v) => v === null || v === undefined ? null : typeof v === "string" ? v : null;
      return {
        pr_url: str(row.pr_url),
        pr_head_sha: str(row.pr_head_sha),
        pr_state: str(row.pr_state),
        pr_merge_state: str(row.pr_merge_state),
        pr_classification: str(row.pr_classification),
        pr_base_ref: str(row.pr_base_ref),
        pr_base_sha: str(row.pr_base_sha),
        pr_drift_checked_at_ms: num(row.pr_drift_checked_at_ms),
        base_sha_pinned: str(row.base_sha_pinned),
        base_sha_pinned_at_ms: num(row.base_sha_pinned_at_ms)
      };
    }, "readPrDriftState");
  }
  updatePrDriftState(jobId, drift) {
    return withRetry(() => {
      const ALLOWED = [
        "pr_url",
        "pr_head_sha",
        "pr_state",
        "pr_merge_state",
        "pr_classification",
        "pr_base_ref",
        "pr_base_sha",
        "pr_drift_checked_at_ms",
        "base_sha_pinned",
        "base_sha_pinned_at_ms"
      ];
      const setClauses = [];
      const params = [];
      for (const key of ALLOWED) {
        if (!Object.prototype.hasOwnProperty.call(drift, key))
          continue;
        setClauses.push(`${key} = ?`);
        const value = drift[key];
        params.push(value === undefined ? null : value);
      }
      if (setClauses.length === 0)
        return false;
      setClauses.push("updated_at_ms = ?");
      params.push(Date.now());
      params.push(jobId);
      const sql = `UPDATE specialist_jobs SET ${setClauses.join(", ")} WHERE job_id = ?`;
      const result = this.db.run(sql, params);
      return (result?.changes ?? 0) > 0;
    }, "updatePrDriftState");
  }
  listStaleSpecialistJobs(opts) {
    return withRetry(() => {
      const nowMs = opts?.nowMs ?? Date.now();
      const minAgeMs = opts?.minAgeMs ?? 60000;
      const cutoff = nowMs - minAgeMs;
      const statuses = ["starting", "running", "waiting"];
      const placeholders = statuses.map(() => "?").join(", ");
      const rows = this.db.query(`
        SELECT job_id, specialist, status, status_json,
               JSON_EXTRACT(status_json, '$.pid') AS pid,
               updated_at_ms,
               bead_id,
               chain_id
        FROM specialist_jobs
        WHERE status IN (${placeholders})
          AND pid IS NOT NULL
          AND updated_at_ms < ?
        ORDER BY updated_at_ms ASC
        LIMIT 200
      `).all(...statuses, cutoff);
      const num = (v) => v === null || v === undefined ? 0 : typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : 0;
      const str = (v) => v === null || v === undefined ? null : typeof v === "string" ? v : null;
      return rows.filter((row) => {
        const pid = num(row.pid);
        return Number.isInteger(pid) && pid > 0;
      }).map((row) => ({
        job_id: str(row.job_id) ?? "",
        specialist: str(row.specialist) ?? "",
        status: str(row.status) ?? "",
        pid: num(row.pid),
        updated_at_ms: num(row.updated_at_ms),
        bead_id: str(row.bead_id),
        chain_id: str(row.chain_id)
      }));
    }, "listStaleSpecialistJobs");
  }
  listJobsNeedingPrDriftRefresh(olderThanMs) {
    return withRetry(() => {
      const threshold = olderThanMs ?? Date.now() - 5 * 60 * 1000;
      const rows = this.db.query(`
        SELECT job_id, pr_url, pr_head_sha, pr_drift_checked_at_ms,
               JSON_EXTRACT(status_json, '$.branch') AS branch
        FROM specialist_jobs
        WHERE pr_url IS NOT NULL
          AND (pr_drift_checked_at_ms IS NULL OR pr_drift_checked_at_ms < ?)
        ORDER BY pr_drift_checked_at_ms ASC NULLS FIRST
        LIMIT 50
      `).all(threshold);
      const num = (v) => v === null || v === undefined ? null : typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : null;
      const str = (v) => v === null || v === undefined ? null : typeof v === "string" ? v : null;
      return rows.map((row) => ({
        job_id: str(row.job_id) ?? "",
        pr_url: str(row.pr_url) ?? "",
        pr_head_sha: str(row.pr_head_sha),
        pr_drift_checked_at_ms: num(row.pr_drift_checked_at_ms),
        branch: str(row.branch)
      }));
    }, "listJobsNeedingPrDriftRefresh");
  }
  removeJobs(jobIds) {
    return withRetry(() => {
      if (jobIds.length === 0)
        return 0;
      const placeholders = jobIds.map(() => "?").join(", ");
      const result = this.db.query(`DELETE FROM specialist_jobs WHERE job_id IN (${placeholders})`).run(...jobIds);
      return result.changes ?? 0;
    }, "removeJobs");
  }
  readEpicRun(epicId) {
    return withRetry(() => {
      const row = this.db.query("SELECT epic_id, status, status_json, updated_at_ms FROM epic_runs WHERE epic_id = ? LIMIT 1").get(epicId);
      return row ?? null;
    }, "readEpicRun");
  }
  listEpicRuns() {
    return withRetry(() => {
      return this.db.query("SELECT epic_id, status, status_json, updated_at_ms FROM epic_runs ORDER BY updated_at_ms DESC").all();
    }, "listEpicRuns");
  }
  resolveEpicByChainId(chainId) {
    return withRetry(() => {
      const row = this.db.query("SELECT chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms FROM epic_chain_membership WHERE chain_id = ? LIMIT 1").get(chainId);
      return row ?? null;
    }, "resolveEpicByChainId");
  }
  resolveEpicByChainRootBeadId(chainRootBeadId) {
    return withRetry(() => {
      const row = this.db.query("SELECT chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms FROM epic_chain_membership WHERE chain_root_bead_id = ? LIMIT 1").get(chainRootBeadId);
      return row ?? null;
    }, "resolveEpicByChainRootBeadId");
  }
  listEpicChains(epicId) {
    return withRetry(() => {
      return this.db.query(`
        SELECT chain_id, epic_id, chain_root_bead_id, chain_root_job_id, updated_at_ms
        FROM epic_chain_membership
        WHERE epic_id = ?
        ORDER BY updated_at_ms DESC
      `).all(epicId);
    }, "listEpicChains");
  }
  deleteEpicChainMembership(epicId, chainIds) {
    if (chainIds.length === 0)
      return [];
    return withRetry(() => {
      const existing = new Set(this.db.query("SELECT chain_id FROM epic_chain_membership WHERE epic_id = ?").all(epicId).map((row) => row.chain_id));
      const removable = chainIds.filter((chainId) => existing.has(chainId));
      if (removable.length === 0)
        return [];
      const placeholders = removable.map(() => "?").join(", ");
      this.db.query(`DELETE FROM epic_chain_membership WHERE epic_id = ? AND chain_id IN (${placeholders})`).run(epicId, ...removable);
      return removable;
    }, "deleteEpicChainMembership");
  }
  listReferencedChainRootJobIds() {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT DISTINCT chain_root_job_id
        FROM epic_chain_membership
        WHERE chain_root_job_id IS NOT NULL AND chain_root_job_id != ''
      `).all();
      return rows.map((row) => row.chain_root_job_id).filter((jobId) => typeof jobId === "string" && jobId.length > 0);
    }, "listReferencedChainRootJobIds");
  }
  listEpicChainsWithLatestJob(epicId) {
    return withRetry(() => {
      const rows = this.db.query(`
        WITH ranked_jobs AS (
          SELECT
            jobs.chain_id AS chain_id,
            membership.epic_id AS epic_id,
            membership.chain_root_bead_id AS chain_root_bead_id,
            membership.chain_root_job_id AS chain_root_job_id,
            jobs.job_id AS job_id,
            jobs.status AS status,
            json_extract(jobs.status_json, '$.branch') AS branch,
            jobs.updated_at_ms AS updated_at_ms,
            ROW_NUMBER() OVER (
              PARTITION BY jobs.chain_id
              ORDER BY jobs.updated_at_ms DESC, jobs.rowid DESC
            ) AS row_rank
          FROM epic_chain_membership membership
          INNER JOIN specialist_jobs jobs ON jobs.chain_id = membership.chain_id
          WHERE membership.epic_id = ?
            AND jobs.chain_kind = 'chain'
        )
        SELECT
          chain_id,
          epic_id,
          chain_root_bead_id,
          chain_root_job_id,
          job_id,
          status,
          branch,
          updated_at_ms
        FROM ranked_jobs
        WHERE row_rank = 1
        ORDER BY updated_at_ms DESC, job_id DESC
      `).all(epicId);
      return rows.map((row) => ({
        chain_id: row.chain_id,
        epic_id: row.epic_id,
        chain_root_bead_id: row.chain_root_bead_id ?? undefined,
        chain_root_job_id: row.chain_root_job_id ?? undefined,
        job_id: row.job_id,
        status: row.status ?? undefined,
        branch: row.branch ?? undefined,
        updated_at_ms: row.updated_at_ms
      }));
    }, "listEpicChainsWithLatestJob");
  }
  readChainIdentity(jobId) {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT chain_kind, chain_id, chain_root_job_id, chain_root_bead_id
        FROM specialist_jobs
        WHERE job_id = ?
        LIMIT 1
      `).get(jobId);
      if (!row?.chain_kind || row.chain_kind.trim().length === 0) {
        return { chain_kind: "prep" };
      }
      return {
        chain_kind: row.chain_kind === "chain" ? "chain" : "prep",
        chain_id: row.chain_id ?? undefined,
        chain_root_job_id: row.chain_root_job_id ?? undefined,
        chain_root_bead_id: row.chain_root_bead_id ?? undefined
      };
    }, "readChainIdentity");
  }
  listChainJobIds(chainId) {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT job_id
        FROM specialist_jobs
        WHERE chain_id = ?
        ORDER BY updated_at_ms ASC
      `).all(chainId);
      return rows.map((row) => row.job_id).filter((jobId) => typeof jobId === "string" && jobId.length > 0);
    }, "listChainJobIds");
  }
  listLiveJobsForBead(beadId) {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT job_id
        FROM specialist_jobs
        WHERE bead_id = ?
          AND status IN ('starting', 'running', 'waiting')
        ORDER BY updated_at_ms ASC
      `).all(beadId);
      return rows.map((row) => row.job_id).filter((jobId) => typeof jobId === "string" && jobId.length > 0);
    }, "listLiveJobsForBead");
  }
  resolveChainEpicLinkByJobId(jobId) {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT
          jobs.chain_id AS chain_id,
          COALESCE(membership.epic_id, jobs.epic_id) AS epic_id,
          COALESCE(jobs.chain_root_job_id, membership.chain_root_job_id, jobs.chain_id) AS chain_root_job_id,
          COALESCE(jobs.chain_root_bead_id, membership.chain_root_bead_id) AS chain_root_bead_id
        FROM specialist_jobs jobs
        LEFT JOIN epic_chain_membership membership ON membership.chain_id = jobs.chain_id
        WHERE jobs.job_id = ?
          AND jobs.chain_kind = 'chain'
          AND jobs.chain_id IS NOT NULL
        LIMIT 1
      `).get(jobId);
      return row ?? null;
    }, "resolveChainEpicLinkByJobId");
  }
  readEvents(jobId) {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT seq, event_json FROM specialist_events
        WHERE job_id = ?
        ORDER BY seq ASC, id ASC;
      `).all(jobId);
      const events = [];
      for (const row of rows) {
        if (!row.event_json)
          continue;
        try {
          const parsed = JSON.parse(row.event_json);
          events.push(typeof parsed.seq === "number" ? parsed : { ...parsed, seq: row.seq });
        } catch {}
      }
      return events;
    }, "readEvents");
  }
  readEventsAfterSeq(jobId, afterSeq) {
    return withRetry(() => {
      const rows = this.db.query(`
        SELECT seq, event_json FROM specialist_events
        WHERE job_id = ? AND seq > ?
        ORDER BY seq ASC, id ASC;
      `).all(jobId, afterSeq);
      const events = [];
      for (const row of rows) {
        if (!row.event_json)
          continue;
        try {
          const parsed = JSON.parse(row.event_json);
          events.push(typeof parsed.seq === "number" ? parsed : { ...parsed, seq: row.seq });
        } catch {}
      }
      return events;
    }, "readEventsAfterSeq");
  }
  readForensicEvents(filters = {}) {
    return withRetry(() => {
      const clauses = [];
      const params = [];
      if (filters.jobId) {
        clauses.push("job_id = ?");
        params.push(filters.jobId);
      }
      if (filters.sinceMs !== undefined) {
        clauses.push("t >= ?");
        params.push(filters.sinceMs);
      }
      if (filters.eventFamily) {
        clauses.push("event_family = ?");
        params.push(filters.eventFamily);
      }
      if (filters.eventName) {
        clauses.push("event_name = ?");
        params.push(filters.eventName);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(filters.limit ?? 1000, 1e4));
      const dir = filters.order === "desc" ? "DESC" : "ASC";
      return this.db.query(`
        SELECT id, job_id, seq, t, schema_version, event_family, event_name,
               participant_kind, participant_role, participant_id, attempt_id, redaction_status, event_json
        FROM specialist_forensic_events
        ${where}
        ORDER BY t ${dir}, seq ${dir}, id ${dir}
        LIMIT ?
      `).all(...params, limit);
    }, "readForensicEvents");
  }
  readLatestToolEvent(jobId) {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT seq, event_json FROM specialist_events
        WHERE job_id = ? AND type = 'tool'
        ORDER BY seq DESC, id DESC
        LIMIT 1;
      `).get(jobId);
      if (!row?.event_json)
        return null;
      try {
        const parsed = JSON.parse(row.event_json);
        if (parsed.type !== "tool")
          return null;
        return typeof parsed.seq === "number" ? parsed : { ...parsed, seq: row.seq };
      } catch {
        return null;
      }
    }, "readLatestToolEvent");
  }
  getLastActivityTimestampMs(jobId) {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT MAX(t) AS last_activity_ms
        FROM specialist_events
        WHERE job_id = ? AND type IN ('tool', 'think')
      `).get(jobId);
      return typeof row?.last_activity_ms === "number" ? row.last_activity_ms : null;
    }, "getLastActivityTimestampMs");
  }
  aggregateJobMetrics(jobId) {
    return withRetry(() => {
      const jobRow = this.db.query(`
        SELECT job_id, specialist, status, chain_kind, chain_id, bead_id, node_id, epic_id, updated_at_ms, startup_payload_json
        FROM specialist_jobs
        WHERE job_id = ?
      `).get(jobId);
      if (!jobRow)
        return null;
      const events = this.readEvents(jobId);
      const toolCallCounts = {};
      const tokenTrajectory = [];
      const contextTrajectory = [];
      const stallGaps = [];
      let totalTools = 0;
      let totalTurns = 0;
      let startedAtMs = null;
      let completedAtMs = null;
      let runCompleteJson = null;
      let model = null;
      let elapsedMs = null;
      let activeRuntimeMs = 0;
      let waitingMs = 0;
      let phase = null;
      let phaseStartedAtMs = null;
      const closePhase = (endAtMs) => {
        if (phase === null || phaseStartedAtMs === null || endAtMs < phaseStartedAtMs)
          return;
        const durationMs = endAtMs - phaseStartedAtMs;
        if (phase === "running") {
          activeRuntimeMs += durationMs;
        } else {
          waitingMs += durationMs;
        }
      };
      for (const event of events) {
        startedAtMs = startedAtMs === null ? event.t : Math.min(startedAtMs, event.t);
        if (event.type === "tool") {
          totalTools += 1;
          toolCallCounts[event.tool] = (toolCallCounts[event.tool] ?? 0) + 1;
          continue;
        }
        if (event.type === "turn_summary") {
          totalTurns += 1;
          if (event.token_usage)
            tokenTrajectory.push({ turn_index: event.turn_index, t: event.t, token_usage: event.token_usage });
          if (event.context_pct !== undefined)
            contextTrajectory.push({ turn_index: event.turn_index, t: event.t, context_pct: event.context_pct });
          continue;
        }
        if (event.type === "token_usage") {
          tokenTrajectory.push({ t: event.t, source: event.source, token_usage: event.token_usage });
          continue;
        }
        if (event.type === "run_start") {
          phase = "running";
          phaseStartedAtMs = event.t;
          continue;
        }
        if (event.type === "status_change") {
          if (event.status === "running" || event.status === "waiting") {
            closePhase(event.t);
            phase = event.status;
            phaseStartedAtMs = event.t;
            continue;
          }
          if (event.status === "done" || event.status === "error" || event.status === "cancelled") {
            closePhase(event.t);
            phase = null;
            phaseStartedAtMs = null;
          }
          continue;
        }
        if (event.type === "run_complete") {
          closePhase(event.t);
          completedAtMs = event.t;
          runCompleteJson = JSON.stringify(event);
          model = event.model ?? model;
          elapsedMs = Math.round(event.elapsed_s * 1000);
          phase = null;
          phaseStartedAtMs = null;
          continue;
        }
        if (event.type === "stale_warning" && event.reason === "tool_duration") {
          stallGaps.push({ t: event.t, tool: event.tool ?? null, silence_ms: event.silence_ms, threshold_ms: event.threshold_ms });
        }
      }
      if (startedAtMs !== null && completedAtMs === null) {
        completedAtMs = events.length > 0 ? events[events.length - 1].t : startedAtMs;
      }
      if (elapsedMs === null && startedAtMs !== null && completedAtMs !== null) {
        elapsedMs = Math.max(0, completedAtMs - startedAtMs);
      }
      const record = {
        job_id: jobRow.job_id,
        specialist: jobRow.specialist,
        model,
        status: jobRow.status,
        chain_kind: jobRow.chain_kind ?? null,
        chain_id: jobRow.chain_id ?? null,
        bead_id: jobRow.bead_id ?? null,
        node_id: jobRow.node_id ?? null,
        epic_id: jobRow.epic_id ?? null,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        elapsed_ms: elapsedMs,
        active_runtime_ms: activeRuntimeMs,
        waiting_ms: waitingMs,
        total_turns: totalTurns,
        total_tools: totalTools,
        tool_call_counts_json: stringifyJson(toolCallCounts),
        token_trajectory_json: stringifyJson(tokenTrajectory),
        context_trajectory_json: stringifyJson(contextTrajectory),
        stall_gaps_json: stringifyJson(stallGaps),
        run_complete_json: runCompleteJson,
        startup_payload_json: jobRow.startup_payload_json ?? null,
        updated_at_ms: jobRow.updated_at_ms
      };
      this.db.run(`
        INSERT INTO specialist_job_metrics (
          job_id, specialist, model, status, chain_kind, chain_id, bead_id, node_id, epic_id,
          started_at_ms, completed_at_ms, elapsed_ms, active_runtime_ms, waiting_ms, total_turns, total_tools,
          tool_call_counts_json, token_trajectory_json, context_trajectory_json, stall_gaps_json,
          run_complete_json, startup_payload_json, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          specialist = excluded.specialist,
          model = excluded.model,
          status = excluded.status,
          chain_kind = excluded.chain_kind,
          chain_id = excluded.chain_id,
          bead_id = excluded.bead_id,
          node_id = excluded.node_id,
          epic_id = excluded.epic_id,
          started_at_ms = excluded.started_at_ms,
          completed_at_ms = excluded.completed_at_ms,
          elapsed_ms = excluded.elapsed_ms,
          active_runtime_ms = excluded.active_runtime_ms,
          waiting_ms = excluded.waiting_ms,
          total_turns = excluded.total_turns,
          total_tools = excluded.total_tools,
          tool_call_counts_json = excluded.tool_call_counts_json,
          token_trajectory_json = excluded.token_trajectory_json,
          context_trajectory_json = excluded.context_trajectory_json,
          stall_gaps_json = excluded.stall_gaps_json,
          run_complete_json = excluded.run_complete_json,
          startup_payload_json = excluded.startup_payload_json,
          updated_at_ms = excluded.updated_at_ms;
      `, [
        record.job_id,
        record.specialist,
        record.model,
        record.status,
        record.chain_kind,
        record.chain_id,
        record.bead_id,
        record.node_id,
        record.epic_id,
        record.started_at_ms,
        record.completed_at_ms,
        record.elapsed_ms,
        record.active_runtime_ms,
        record.waiting_ms,
        record.total_turns,
        record.total_tools,
        record.tool_call_counts_json,
        record.token_trajectory_json,
        record.context_trajectory_json,
        record.stall_gaps_json,
        record.run_complete_json,
        record.startup_payload_json,
        record.updated_at_ms
      ]);
      return record;
    }, "aggregateJobMetrics");
  }
  listJobMetrics(filters) {
    return withRetry(() => {
      const clauses = [];
      const params = [];
      if (filters?.spec) {
        clauses.push("specialist = ?");
        params.push(filters.spec);
      }
      if (filters?.model) {
        clauses.push("model LIKE ?");
        params.push(filters.model.replace(/\*/g, "%"));
      }
      if (filters?.sinceMs !== undefined) {
        clauses.push("updated_at_ms >= ?");
        params.push(filters.sinceMs);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      return this.db.query(`SELECT * FROM specialist_job_metrics ${where} ORDER BY updated_at_ms DESC, job_id DESC`).all(...params);
    }, "listJobMetrics");
  }
  listElapsedMsBySpecialist(sinceMs, limitPerSpecialist = 200) {
    return withRetry(() => {
      const rows = this.db.query(`
        WITH ranked AS (
          SELECT specialist, elapsed_ms,
                 ROW_NUMBER() OVER (PARTITION BY specialist ORDER BY updated_at_ms DESC) AS rn
          FROM specialist_job_metrics
          WHERE status = 'completed' AND updated_at_ms >= ? AND elapsed_ms IS NOT NULL
        )
        SELECT specialist, elapsed_ms
        FROM ranked
        WHERE rn <= ?
        ORDER BY specialist, rn
      `).all(sinceMs, limitPerSpecialist);
      const bySpecialist = {};
      for (const row of rows) {
        if (!row.specialist || typeof row.elapsed_ms !== "number" || !Number.isFinite(row.elapsed_ms))
          continue;
        (bySpecialist[row.specialist] ??= []).push(row.elapsed_ms);
      }
      return bySpecialist;
    }, "listElapsedMsBySpecialist");
  }
  readResult(jobId) {
    return withRetry(() => {
      const row = this.db.query("SELECT output FROM specialist_results WHERE job_id = ? LIMIT 1").get(jobId);
      return row?.output ?? null;
    }, "readResult");
  }
  syncMemoriesCache(memories, syncedAtMs = Date.now()) {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.db.run("DELETE FROM memories_fts");
        const upsertMemory = this.db.query(`
          INSERT INTO memories_cache (memory_key, memory_value, updated_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(memory_key) DO UPDATE SET
            memory_value = excluded.memory_value,
            updated_at_ms = excluded.updated_at_ms
        `);
        const insertFts = this.db.query("INSERT INTO memories_fts (key, content) VALUES (?, ?)");
        const seen = new Set;
        for (const memory of memories) {
          if (!memory.key || seen.has(memory.key))
            continue;
          seen.add(memory.key);
          upsertMemory.run(memory.key, memory.value, syncedAtMs);
          insertFts.run(memory.key, `${memory.key} ${memory.value}`);
        }
        if (seen.size > 0) {
          const placeholders = [...seen].map(() => "?").join(", ");
          this.db.query(`DELETE FROM memories_cache WHERE memory_key NOT IN (${placeholders})`).run(...seen);
        } else {
          this.db.run("DELETE FROM memories_cache");
        }
        this.db.query(`
          INSERT INTO memories_cache_meta (singleton_key, last_sync_at_ms, memory_count)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton_key) DO UPDATE SET
            last_sync_at_ms = excluded.last_sync_at_ms,
            memory_count = excluded.memory_count
        `).run(syncedAtMs, seen.size);
      });
      transaction();
    }, "syncMemoriesCache");
  }
  getMemoriesCacheState() {
    return withRetry(() => {
      const row = this.db.query(`
        SELECT last_sync_at_ms, memory_count
        FROM memories_cache_meta
        WHERE singleton_key = 1
        LIMIT 1
      `).get();
      if (!row || typeof row.last_sync_at_ms !== "number" || typeof row.memory_count !== "number") {
        return null;
      }
      return { lastSyncAtMs: row.last_sync_at_ms, memoryCount: row.memory_count };
    }, "getMemoriesCacheState");
  }
  queryRelevantMemories(keywords, limit = 10, nowMs = Date.now()) {
    return withRetry(() => {
      const cleanedKeywords = [...new Set(keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0))];
      if (cleanedKeywords.length === 0)
        return [];
      const matchQuery = cleanedKeywords.map((keyword) => `"${keyword.replace(/"/g, '""')}"`).join(" OR ");
      const rows = this.db.query(`
        SELECT
          cache.memory_key,
          cache.memory_value,
          bm25(memories_fts) AS bm25_score,
          COALESCE((? - cache.updated_at_ms) / 3600000.0, 999999.0) AS age_hours,
          cache.access_count
        FROM memories_fts
        JOIN memories_cache cache ON cache.memory_key = memories_fts.key
        WHERE memories_fts MATCH ?
        ORDER BY bm25_score ASC
        LIMIT ?
      `).all(nowMs, matchQuery, Math.max(1, limit * 3));
      const ranked = rows.map((row) => {
        const bm25 = Number.isFinite(row.bm25_score) ? row.bm25_score : 100;
        const bm25Norm = 1 / (1 + Math.max(0, bm25));
        const recency = Math.exp(-Math.max(0, row.age_hours) / 72);
        const accessFrequency = Math.min(1, Math.log1p(Math.max(0, row.access_count)) / Math.log(10));
        const score = 0.5 * bm25Norm + 0.3 * recency + 0.2 * accessFrequency;
        return {
          key: row.memory_key,
          value: row.memory_value,
          bm25,
          recency,
          accessFrequency,
          score
        };
      });
      ranked.sort((left, right) => right.score - left.score);
      const selected = ranked.slice(0, Math.max(1, limit));
      if (selected.length === 0)
        return [];
      const accessStmt = this.db.query(`
        UPDATE memories_cache
        SET access_count = access_count + 1,
            last_accessed_at_ms = ?
        WHERE memory_key = ?
      `);
      for (const memory of selected) {
        accessStmt.run(nowMs, memory.key);
      }
      return selected;
    }, "queryRelevantMemories");
  }
  invalidateMemoriesCache() {
    withRetry(() => {
      const transaction = this.db.transaction(() => {
        this.db.run("DELETE FROM memories_fts");
        this.db.run("DELETE FROM memories_cache");
        this.db.run("DELETE FROM memories_cache_meta");
      });
      transaction();
    }, "invalidateMemoriesCache");
  }
  hasActiveJobs(statuses = ["running", "starting"]) {
    return this.listActiveJobs(statuses).length > 0;
  }
  listActiveJobs(statuses = ["running", "starting"]) {
    return withRetry(() => {
      if (statuses.length === 0)
        return [];
      const placeholders = statuses.map(() => "?").join(", ");
      return this.db.query(`
        SELECT job_id, specialist, status
        FROM specialist_jobs
        WHERE status IN (${placeholders})
        ORDER BY updated_at_ms DESC
      `).all(...statuses);
    }, "listActiveJobs");
  }
  getDatabaseSizeBytes() {
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }
  vacuumDatabase() {
    return withRetry(() => {
      const beforeBytes = this.getDatabaseSizeBytes();
      this.db.run("VACUUM");
      const afterBytes = this.getDatabaseSizeBytes();
      return { beforeBytes, afterBytes };
    }, "vacuumDatabase");
  }
  pruneObservabilityData(options) {
    return withRetry(() => {
      const nowMs = options.nowMs ?? Date.now();
      const eventsRetentionMs = options.eventsRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
      const eventsCutoffMs = nowMs - eventsRetentionMs;
      const terminalStatuses = ["done", "error", "stopped"];
      const activeStatuses = ["running", "starting", "waiting"];
      const skippedActiveChainJobs = this.db.query(`
        SELECT COUNT(*) AS count
        FROM specialist_jobs stale
        WHERE stale.updated_at_ms < ?
          AND stale.status IN (${terminalStatuses.map(() => "?").join(", ")})
          AND stale.chain_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM specialist_jobs active
            WHERE active.chain_id = stale.chain_id
              AND active.status IN (${activeStatuses.map(() => "?").join(", ")})
          )
      `).get(options.beforeMs, ...terminalStatuses, ...activeStatuses)?.count ?? 0;
      const resultCandidates = this.db.query(`
        SELECT COUNT(*) AS count
        FROM specialist_results results
        LEFT JOIN specialist_jobs jobs ON jobs.job_id = results.job_id
        WHERE results.updated_at_ms < ?
          AND (
            jobs.job_id IS NULL
            OR jobs.chain_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM specialist_jobs active
              WHERE active.chain_id = jobs.chain_id
                AND active.status IN (${activeStatuses.map(() => "?").join(", ")})
            )
          )
      `).get(options.beforeMs, ...activeStatuses)?.count ?? 0;
      const jobCandidates = this.db.query(`
        SELECT COUNT(*) AS count
        FROM specialist_jobs stale
        WHERE stale.updated_at_ms < ?
          AND stale.status IN (${terminalStatuses.map(() => "?").join(", ")})
          AND (
            stale.chain_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM specialist_jobs active
              WHERE active.chain_id = stale.chain_id
                AND active.status IN (${activeStatuses.map(() => "?").join(", ")})
            )
          )
      `).get(options.beforeMs, ...terminalStatuses, ...activeStatuses)?.count ?? 0;
      const extractCandidates = options.skipExtract ? 0 : this.db.query(`
          SELECT COUNT(DISTINCT job_id) AS count
          FROM specialist_events
          WHERE t < ?
        `).get(eventsCutoffMs)?.count ?? 0;
      const eventsCandidates = this.db.query("SELECT COUNT(*) AS count FROM specialist_events WHERE t < ?").get(eventsCutoffMs)?.count ?? 0;
      const epicCandidates = options.includeEpics ? this.db.query(`
          SELECT COUNT(*) AS count
          FROM epic_runs epic
          WHERE epic.updated_at_ms < ?
            AND epic.status IN ('merged', 'failed', 'abandoned')
            AND NOT EXISTS (
              SELECT 1
              FROM epic_chain_membership membership
              WHERE membership.epic_id = epic.epic_id
            )
        `).get(options.beforeMs)?.count ?? 0 : 0;
      if (!options.apply) {
        return {
          dryRun: true,
          beforeMs: options.beforeMs,
          eventsCutoffMs,
          includeEpics: options.includeEpics,
          deletedEvents: eventsCandidates,
          deletedResults: resultCandidates,
          deletedJobs: jobCandidates,
          deletedEpicRuns: epicCandidates,
          skippedActiveChainJobs,
          extractedJobs: extractCandidates
        };
      }
      let extractedJobs = 0;
      if (!options.skipExtract) {
        const jobsToExtract = this.db.query(`
          SELECT DISTINCT stale.job_id
          FROM specialist_events stale
          WHERE stale.t < ?
        `).all(eventsCutoffMs);
        for (const row of jobsToExtract) {
          if (!row.job_id)
            continue;
          const metrics = this.aggregateJobMetrics(row.job_id);
          if (!metrics) {
            throw new Error(`Failed to aggregate metrics for job ${row.job_id}`);
          }
          extractedJobs += 1;
        }
      }
      const deleteResults = this.db.query(`
        DELETE FROM specialist_results
        WHERE updated_at_ms < ?
          AND (
            job_id NOT IN (SELECT job_id FROM specialist_jobs WHERE chain_id IS NOT NULL)
            OR job_id IN (
              SELECT jobs.job_id
              FROM specialist_jobs jobs
              WHERE jobs.chain_id IS NULL
                 OR NOT EXISTS (
                    SELECT 1
                    FROM specialist_jobs active
                    WHERE active.chain_id = jobs.chain_id
                      AND active.status IN (${activeStatuses.map(() => "?").join(", ")})
                 )
            )
          )
      `);
      const deletedResults = deleteResults.run(options.beforeMs, ...activeStatuses).changes ?? 0;
      const deleteEvents = this.db.query("DELETE FROM specialist_events WHERE t < ?");
      const deletedEvents = deleteEvents.run(eventsCutoffMs).changes ?? 0;
      const deleteJobs = this.db.query(`
        DELETE FROM specialist_jobs
        WHERE updated_at_ms < ?
          AND status IN (${terminalStatuses.map(() => "?").join(", ")})
          AND (
            chain_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM specialist_jobs active
              WHERE active.chain_id = specialist_jobs.chain_id
                AND active.status IN (${activeStatuses.map(() => "?").join(", ")})
            )
          )
      `);
      const deletedJobs = deleteJobs.run(options.beforeMs, ...terminalStatuses, ...activeStatuses).changes ?? 0;
      let deletedEpicRuns = 0;
      if (options.includeEpics) {
        const deleteEpics = this.db.query(`
          DELETE FROM epic_runs
          WHERE updated_at_ms < ?
            AND status IN ('merged', 'failed', 'abandoned')
            AND NOT EXISTS (
              SELECT 1
              FROM epic_chain_membership membership
              WHERE membership.epic_id = epic_runs.epic_id
            )
        `);
        deletedEpicRuns = deleteEpics.run(options.beforeMs).changes ?? 0;
      }
      return {
        dryRun: false,
        beforeMs: options.beforeMs,
        eventsCutoffMs,
        includeEpics: options.includeEpics,
        deletedEvents,
        deletedResults,
        deletedJobs,
        deletedEpicRuns,
        skippedActiveChainJobs,
        extractedJobs
      };
    }, "pruneObservabilityData");
  }
  scanOrphans() {
    return withRetry(() => {
      const findings = [];
      const chainMembershipWithoutJobs = this.db.query(`
        SELECT membership.chain_id, membership.epic_id
        FROM epic_chain_membership membership
        LEFT JOIN specialist_jobs jobs ON jobs.chain_id = membership.chain_id
        WHERE jobs.job_id IS NULL
      `).all();
      for (const row of chainMembershipWithoutJobs) {
        findings.push({
          kind: "orphan",
          code: "chain_membership_without_jobs",
          message: `chain ${row.chain_id} has epic membership but no jobs`,
          details: { chain_id: row.chain_id, epic_id: row.epic_id }
        });
      }
      const epicsWithoutChains = this.db.query(`
        SELECT epic.epic_id, epic.status
        FROM epic_runs epic
        LEFT JOIN epic_chain_membership membership ON membership.epic_id = epic.epic_id
        WHERE membership.chain_id IS NULL
      `).all();
      for (const row of epicsWithoutChains) {
        findings.push({
          kind: "orphan",
          code: "epic_without_chains",
          message: `epic ${row.epic_id} has no chain membership`,
          details: { epic_id: row.epic_id, status: row.status }
        });
      }
      const jobEpicWithoutMembership = this.db.query(`
        SELECT jobs.job_id, jobs.epic_id, jobs.chain_id
        FROM specialist_jobs jobs
        LEFT JOIN epic_chain_membership membership
          ON membership.chain_id = jobs.chain_id
         AND membership.epic_id = jobs.epic_id
        WHERE jobs.epic_id IS NOT NULL
          AND (jobs.chain_id IS NULL OR membership.chain_id IS NULL)
      `).all();
      for (const row of jobEpicWithoutMembership) {
        findings.push({
          kind: "integrity-violation",
          code: "job_epic_without_membership",
          message: `job ${row.job_id} references epic without chain membership link`,
          details: { job_id: row.job_id, epic_id: row.epic_id, chain_id: row.chain_id ?? null }
        });
      }
      const worktreeRows = this.db.query(`
        SELECT DISTINCT job_id, worktree_column
        FROM specialist_jobs
        WHERE worktree_column IS NOT NULL AND worktree_column != ''
      `).all();
      for (const row of worktreeRows) {
        if (existsSync7(row.worktree_column))
          continue;
        findings.push({
          kind: "stale-pointer",
          code: "worktree_missing_on_disk",
          message: `job ${row.job_id} points to missing worktree path`,
          details: { job_id: row.job_id, worktree_path: row.worktree_column }
        });
      }
      return findings;
    }, "scanOrphans");
  }
  close() {
    this.db.close();
  }
}
function openObservabilitySqliteClient(dbPath) {
  if (!loadBunDatabase())
    return null;
  try {
    const Ctor = loadBunDatabase();
    const initDb = new Ctor(dbPath);
    initDb.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    initSchema(initDb);
    initDb.close();
    return new SqliteClient(dbPath);
  } catch (error) {
    console.warn(`[observability-sqlite] Failed to open observability database at ${dbPath}: ${String(error)}`);
    return null;
  }
}
function createObservabilitySqliteClient(cwd = process.cwd()) {
  const location = resolveObservabilityDbLocation(cwd);
  if (!existsSync7(location.dbPath))
    return null;
  return openObservabilitySqliteClient(location.dbPath);
}
function createObservabilitySqliteClientAtPath(dbPath) {
  mkdirSync3(dirname5(dbPath), { recursive: true });
  return openObservabilitySqliteClient(dbPath);
}

// src/specialist/memory-retrieval.ts
var DEFAULT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "with",
  "you",
  "your",
  "replace",
  "implement",
  "task",
  "run",
  "add",
  "new",
  "use",
  "using",
  "into",
  "when",
  "what",
  "not",
  "only"
]);
var MAX_KEYWORDS = 6;
var MAX_MEMORIES = 10;
var MAX_MEMORY_TOKENS = 600;
var CACHE_MAX_AGE_MS = 60 * 60 * 1000;
var STATIC_WORKFLOW_RULES_BLOCK = `
## Beads Workflow Quick Rules
- Claim work: \`bd update <id> --claim\`
- Append progress notes: \`bd update <id> --notes "..."\`
- Store reusable insight: \`bd remember "insight"\`
- Close completed issue: \`bd close <id> --reason "done"\`

## Session close checklist
1. \`git add <files>\`
2. \`git commit -m "..."\`
3. \`git push\`
`.trim();
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function normalizeToken(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9_-]/g, "").trim();
}
function extractTokens(input) {
  return input.split(/\s+/g).map(normalizeToken).filter((token) => token.length >= 3 && !DEFAULT_STOP_WORDS.has(token));
}
function extractMemoryKeywords(title, description) {
  const tokens = [
    ...extractTokens(title),
    ...extractTokens(description ?? "")
  ];
  const unique = [];
  const seen = new Set;
  for (const token of tokens) {
    if (seen.has(token))
      continue;
    seen.add(token);
    unique.push(token);
    if (unique.length >= MAX_KEYWORDS)
      break;
  }
  return unique;
}
function parseMemoriesPayload(jsonText) {
  if (!jsonText.trim())
    return [];
  const parsed = JSON.parse(jsonText);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      if (!entry || typeof entry !== "object")
        return null;
      const maybeRecord = entry;
      const key = typeof maybeRecord.key === "string" ? maybeRecord.key : null;
      const value = typeof maybeRecord.value === "string" ? maybeRecord.value : null;
      if (!key || value === null)
        return null;
      return { key, value };
    }).filter((entry) => Boolean(entry));
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string").map(([key, value]) => ({ key, value }));
  }
  return [];
}
function readBdMemories(cwd) {
  try {
    const stdout = execSync("bd memories --json", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    });
    return parseMemoriesPayload(stdout);
  } catch (error) {
    const commandError = error;
    const stderr = typeof commandError.stderr === "string" ? commandError.stderr : commandError.stderr?.toString("utf8") ?? "";
    if (/no beads database found/i.test(stderr)) {
      return [];
    }
    throw error;
  }
}
function shouldRefreshCache(args) {
  if (args.cacheCount === null || args.cacheLastSyncAtMs === null)
    return true;
  if (args.cacheCount !== args.sourceCount)
    return true;
  return args.nowMs - args.cacheLastSyncAtMs > CACHE_MAX_AGE_MS;
}
function toMemoryRecord(memory) {
  return { key: memory.key, value: memory.value };
}
function syncMemoriesCacheFromBd(cwd, nowMs = Date.now(), forceFullSync = false) {
  const sqliteClient = createObservabilitySqliteClient(cwd);
  if (!sqliteClient) {
    return { synced: false, memoryCount: 0 };
  }
  try {
    const sourceMemories = readBdMemories(cwd);
    const cacheState = sqliteClient.getMemoriesCacheState();
    const needsRefresh = forceFullSync || shouldRefreshCache({
      nowMs,
      cacheCount: cacheState?.memoryCount ?? null,
      cacheLastSyncAtMs: cacheState?.lastSyncAtMs ?? null,
      sourceCount: sourceMemories.length
    });
    if (!needsRefresh) {
      return { synced: false, memoryCount: sourceMemories.length };
    }
    sqliteClient.syncMemoriesCache(sourceMemories, nowMs);
    return { synced: true, memoryCount: sourceMemories.length };
  } finally {
    sqliteClient.close();
  }
}
function buildFilteredMemoryInjection(args) {
  const keywords = extractMemoryKeywords(args.beadTitle, args.beadDescription);
  if (keywords.length === 0) {
    return { block: "", memories: [], estimatedTokens: 0 };
  }
  const nowMs = Date.now();
  try {
    syncMemoriesCacheFromBd(args.cwd, nowMs, false);
  } catch {}
  const sqliteClient = createObservabilitySqliteClient(args.cwd);
  if (!sqliteClient) {
    return { block: "", memories: [], estimatedTokens: 0 };
  }
  try {
    const ranked = sqliteClient.queryRelevantMemories(keywords, MAX_MEMORIES, nowMs);
    if (ranked.length === 0) {
      return { block: "", memories: [], estimatedTokens: 0 };
    }
    const selected = [];
    let tokenBudget = 0;
    for (const memory of ranked) {
      const line = `- ${memory.key}: ${memory.value}`;
      const lineTokens = estimateTokens(line);
      if (selected.length > 0 && tokenBudget + lineTokens > MAX_MEMORY_TOKENS)
        break;
      selected.push(toMemoryRecord(memory));
      tokenBudget += lineTokens;
    }
    if (selected.length === 0) {
      return { block: "", memories: [], estimatedTokens: 0 };
    }
    const lines = selected.map((memory) => `- ${memory.key}: ${memory.value}`);
    const block = [
      "## Filtered Beads Memories",
      `_Keyword matched from bead context: ${keywords.join(", ")}_`,
      ...lines
    ].join(`
`);
    return {
      block,
      memories: selected,
      estimatedTokens: estimateTokens(block)
    };
  } catch {
    return { block: "", memories: [], estimatedTokens: 0 };
  } finally {
    sqliteClient.close();
  }
}
function estimateInjectedTokens(text) {
  return estimateTokens(text);
}

// src/specialist/mandatory-rules.ts
class MandatoryRulesBudgetError extends Error {
  budgetLimit;
  candidateTokens;
  mustKeepTokens;
  injectedSectionIds;
  evictedSectionIds;
  outcome = "impossible";
  constructor(budgetLimit, candidateTokens, mustKeepTokens, injectedSectionIds, evictedSectionIds) {
    super(`Mandatory rules MUST_KEEP floor requires ${mustKeepTokens} tokens, exceeding budget ${budgetLimit}`);
    this.budgetLimit = budgetLimit;
    this.candidateTokens = candidateTokens;
    this.mustKeepTokens = mustKeepTokens;
    this.injectedSectionIds = injectedSectionIds;
    this.evictedSectionIds = evictedSectionIds;
    this.name = "MandatoryRulesBudgetError";
  }
  injectedTokens = 0;
}
function formatSectionsBlock(sections) {
  return sections.length > 0 ? `## MANDATORY_RULES
${sections.map((section) => section.block).join(`

`)}` : "";
}
function estimateTokens2(text) {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}
function compileMandatoryRulesBudget(candidateSections, budgetLimit) {
  const sections = candidateSections.filter((section) => section.block.trim() && section.ruleCount > 0);
  const candidateTokens = estimateTokens2(formatSectionsBlock(sections));
  const mustKeep = sections.filter((section) => section.priority === "must_keep");
  const floorTokens = estimateTokens2(formatSectionsBlock(mustKeep));
  if (floorTokens > budgetLimit) {
    throw new MandatoryRulesBudgetError(budgetLimit, candidateTokens, floorTokens, [], sections.map((section) => section.setId));
  }
  const retained = new Set(mustKeep);
  for (const priority of ["important", "optional"]) {
    for (const section of sections.filter((item) => item.priority === priority)) {
      const proposed = sections.filter((item) => retained.has(item) || item === section);
      if (estimateTokens2(formatSectionsBlock(proposed)) <= budgetLimit)
        retained.add(section);
    }
  }
  const injected = sections.filter((section) => retained.has(section));
  const block = formatSectionsBlock(injected);
  const evicted = sections.filter((section) => !retained.has(section));
  return {
    block,
    sections: injected,
    budgetLimit,
    candidateTokens,
    injectedTokens: estimateTokens2(block),
    injectedSectionIds: injected.map((section) => section.setId),
    evictedSectionIds: evicted.map((section) => section.setId),
    payloadDigest: createHash2("sha256").update(block).digest("hex"),
    outcome: evicted.length === 0 ? "full" : "degraded"
  };
}
function readJsonFile(filePath) {
  return JSON.parse(readFileSync4(filePath, "utf8"));
}
function mergeIndex(base, overlay) {
  const dedupe = (values) => values ? Array.from(new Set(values)) : undefined;
  return {
    required_template_sets: dedupe([
      ...base.required_template_sets ?? [],
      ...overlay.required_template_sets ?? []
    ]),
    default_template_sets: dedupe([
      ...base.default_template_sets ?? [],
      ...overlay.default_template_sets ?? []
    ])
  };
}
function loadMandatoryRulesIndex(cwd) {
  const sourcePath = resolve6(cwd, "config/mandatory-rules/index.json");
  const canonicalCopyPath = resolve6(cwd, ".specialists/default/mandatory-rules/index.json");
  const userOverlayPath = resolve6(cwd, ".specialists/user/mandatory-rules/index.json");
  const packageLivePath = resolveCanonicalAssetDir("mandatory-rules");
  const overlayPath = resolve6(cwd, ".specialists/mandatory-rules/index.json");
  const packageLiveIndexPath = packageLivePath ? resolve6(packageLivePath, "index.json") : null;
  const tierPaths = [userOverlayPath, sourcePath, canonicalCopyPath, overlayPath].filter((value) => Boolean(value));
  const tiers = [];
  for (const path of tierPaths) {
    if (existsSync8(path))
      tiers.push(readJsonFile(path));
  }
  if (tiers.length === 0 && packageLiveIndexPath && existsSync8(packageLiveIndexPath)) {
    tiers.push(readJsonFile(packageLiveIndexPath));
  }
  if (tiers.length === 0) {
    console.warn("[specialist runner] Missing mandatory-rules index (checked config/, .specialists/default/, .specialists/); skipping MANDATORY_RULES injection");
    return null;
  }
  return tiers.reduce((acc, next) => mergeIndex(acc, next));
}
function parseQuotedScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function parseRuleEntry(lines, startIndex) {
  const entryLine = lines[startIndex]?.trim();
  if (!entryLine?.startsWith("- "))
    return null;
  const firstLine = entryLine.slice(2).trim();
  const inlineFields = {};
  if (firstLine.length > 0 && !firstLine.includes(":")) {
    inlineFields.text = parseQuotedScalar(firstLine);
  } else if (firstLine.length > 0) {
    const [key, ...rest] = firstLine.split(":");
    inlineFields[key.trim()] = parseQuotedScalar(rest.join(":"));
  }
  let nextIndex = startIndex + 1;
  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    if (!line.trim()) {
      nextIndex += 1;
      continue;
    }
    if (/^\s*-\s+/.test(line))
      break;
    if (!/^\s+/.test(line))
      break;
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      nextIndex += 1;
      continue;
    }
    inlineFields[match[1]] = parseQuotedScalar(match[2]);
    nextIndex += 1;
  }
  if (!inlineFields.text)
    return null;
  return {
    rule: {
      id: inlineFields.id ?? "",
      level: inlineFields.level ?? "required",
      text: inlineFields.text,
      ...inlineFields.when ? { when: inlineFields.when } : {}
    },
    nextIndex
  };
}
function parseMandatoryRulesFrontmatter(content, setId) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch)
    return [];
  const lines = frontmatterMatch[1].split(`
`);
  const rulesHeaderIndex = lines.findIndex((line) => /^rules:\s*$/.test(line.trim()));
  if (rulesHeaderIndex === -1)
    return [];
  const rules = [];
  let index = rulesHeaderIndex + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (!/^\s*-\s+/.test(line))
      break;
    const parsed = parseRuleEntry(lines, index);
    if (!parsed)
      break;
    const ruleIndex = rules.length + 1;
    rules.push({
      id: parsed.rule.id || `${setId}-${ruleIndex}`,
      level: parsed.rule.level,
      text: parsed.rule.text,
      ...parsed.rule.when ? { when: parsed.rule.when } : {}
    });
    index = parsed.nextIndex;
  }
  return rules;
}
function readMandatoryRuleSet(cwd, id) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    console.warn(`[specialist runner] Rejecting unsafe mandatory-rules set id '${id}' (must be kebab-case)`);
    return null;
  }
  const packageCanonicalDir = resolveCanonicalAssetDir("mandatory-rules");
  const candidates = [
    resolve6(cwd, `.specialists/user/mandatory-rules/${id}.md`),
    resolve6(cwd, `.specialists/mandatory-rules/${id}.md`),
    resolve6(cwd, `.specialists/default/mandatory-rules/${id}.md`),
    resolve6(cwd, `config/mandatory-rules/${id}.md`),
    ...packageCanonicalDir ? [resolve6(packageCanonicalDir, `${id}.md`)] : []
  ];
  const filePath = candidates.find((path) => existsSync8(path));
  if (!filePath)
    return null;
  const content = readFileSync4(filePath, "utf8");
  const rules = parseMandatoryRulesFrontmatter(content, id);
  if (rules.length > 0)
    return { id, rules };
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!body)
    return null;
  return {
    id,
    rules: [{ id: `${id}-1`, level: "required", text: body.replace(/\s+/g, " ") }]
  };
}
function formatMandatoryRulesBlock(sets, inlineRules = []) {
  if (sets.length === 0 && inlineRules.length === 0)
    return { block: "", sections: [] };
  const sections = [
    ...sets.map((set) => {
      const rules = set.rules.map((rule) => `- [${rule.level}] ${rule.text}`).join(`
`);
      return { setId: set.id, priority: set.priority, ruleCount: set.rules.length, block: `### ${set.id}
${rules}` };
    }),
    ...inlineRules.length > 0 ? [
      {
        setId: "specialist-inline-rules",
        priority: "must_keep",
        ruleCount: inlineRules.length,
        block: `### specialist-inline-rules
${inlineRules.map((rule, index) => `- [${rule.level}] ${rule.text}${rule.id ? ` (id: ${rule.id})` : ` (id: inline-${index + 1})`}`).join(`
`)}`
      }
    ] : []
  ];
  return { block: `## MANDATORY_RULES
${sections.map((section) => section.block).join(`

`)}`, sections };
}
function collectMandatoryRuleSets(cwd, setIds) {
  const seen = new Set;
  const sets = [];
  for (const id of setIds) {
    if (seen.has(id))
      continue;
    seen.add(id);
    const set = readMandatoryRuleSet(cwd, id);
    if (!set) {
      console.warn(`[specialist runner] Missing mandatory-rules set: ${id}`);
      continue;
    }
    sets.push(set);
  }
  return sets;
}
function buildMandatoryRulesInjection(specialistConfig, budgetLimit = Number.POSITIVE_INFINITY) {
  const cwd = specialistConfig.cwd ?? process.cwd();
  const index = loadMandatoryRulesIndex(cwd);
  const mandatoryRules = specialistConfig.specialist?.mandatory_rules;
  const setIds = [
    ...index?.required_template_sets ?? [],
    ...index?.default_template_sets ?? [],
    ...mandatoryRules?.template_sets ?? []
  ];
  const sets = collectMandatoryRuleSets(cwd, setIds);
  const inlineRules = mandatoryRules?.inline_rules ?? [];
  const globalsDisabled = mandatoryRules?.disable_default_globals ?? false;
  const globals = globalsDisabled ? [] : [{
    id: "workflow-quick-rules",
    rules: [{ id: "workflow-quick-rules-1", level: "required", text: STATIC_WORKFLOW_RULES_BLOCK.trim().replace(/^##\s+Beads Workflow Quick Rules\n/, "") }],
    priority: "must_keep"
  }];
  const requiredIds = new Set(index?.required_template_sets ?? []);
  const defaultIds = new Set(index?.default_template_sets ?? []);
  const prioritizedSets = sets.map((set) => ({
    ...set,
    priority: requiredIds.has(set.id) ? "must_keep" : defaultIds.has(set.id) ? "important" : "optional"
  }));
  const formatted = formatMandatoryRulesBlock([...globals, ...prioritizedSets], inlineRules);
  const compiled = compileMandatoryRulesBudget(formatted.sections, budgetLimit);
  const injectedSetIds = new Set(compiled.injectedSectionIds);
  return {
    ...compiled,
    setsLoaded: [...globals, ...prioritizedSets].filter((set) => injectedSetIds.has(set.id)).map((set) => set.id),
    ruleCount: compiled.sections.reduce((count, section) => count + section.ruleCount, 0),
    inlineRulesCount: injectedSetIds.has("specialist-inline-rules") ? inlineRules.length : 0,
    globalsDisabled
  };
}

// src/specialist/required-platform-rules.ts
function buildRequiredPlatformRulesInjection(cwd, budgetLimit = Number.POSITIVE_INFINITY) {
  const resolved = buildMandatoryRulesInjection({
    cwd,
    specialist: {
      mandatory_rules: {
        disable_default_globals: true,
        template_sets: [],
        inline_rules: []
      }
    }
  });
  const requiredCandidates = resolved.sections.filter((section) => section.priority === "must_keep");
  const compiled = compileMandatoryRulesBudget(requiredCandidates, budgetLimit);
  const injectedIds = new Set(compiled.injectedSectionIds);
  const retainedRequired = requiredCandidates.filter((section) => injectedIds.has(section.setId));
  return {
    ...resolved,
    ...compiled,
    setsLoaded: retainedRequired.map((section) => section.setId),
    ruleCount: retainedRequired.reduce((count, section) => count + section.ruleCount, 0),
    inlineRulesCount: 0,
    globalsDisabled: true
  };
}
function buildRequiredPlatformRulesBlock(cwd, budgetLimit = Number.POSITIVE_INFINITY) {
  return buildRequiredPlatformRulesInjection(cwd, budgetLimit).block;
}

// src/specialist/model-chain.ts
function resolveModelChain(execution) {
  const primary = normalizeModel(execution.model);
  const fallbacks = resolveFallbackModels(execution);
  return dedupeModels([primary, ...fallbacks].filter((model) => model !== null));
}
function resolveFallbackModels(execution) {
  if (execution.fallback_models && execution.fallback_models.length > 0) {
    if (normalizeModel(execution.fallback_model ?? null)) {
      console.debug(`[model-chain] plural fallback_models wins; ignoring fallback_model=${execution.fallback_model}`);
    }
    return execution.fallback_models.map(normalizeModel).filter((model) => model !== null);
  }
  const fallback = normalizeModel(execution.fallback_model ?? null);
  return fallback ? [fallback] : [];
}
function normalizeModel(model) {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}
function dedupeModels(models) {
  return [...new Set(models)];
}

// src/specialist/task-prompt.ts
import { basename, dirname as dirname6 } from "node:path";
import { createHash as createHash3 } from "node:crypto";

// src/specialist/templateEngine.ts
var PLACEHOLDER_RE = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
function extractTemplateTokens(template) {
  return [...template.matchAll(PLACEHOLDER_RE)].map((match) => match[1]);
}
function renderTemplate(template, variables) {
  return template.replace(PLACEHOLDER_RE, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
}

// src/specialist/beads.ts
import { spawnSync as spawnSync2 } from "node:child_process";
function buildBeadContext(bead, completedBlockers = []) {
  const lines = [`# Task: ${bead.title}`, `## Bead id: ${bead.id}`];
  if (bead.description?.trim()) {
    lines.push(bead.description.trim());
  }
  if (bead.parent?.trim()) {
    lines.push("", "## Parent epic", bead.parent.trim());
  }
  if (bead.notes?.trim()) {
    lines.push("", "## Notes", bead.notes.trim());
  }
  if (completedBlockers.length > 0) {
    lines.push("", "## Context from completed dependencies:");
    for (const blocker of completedBlockers) {
      lines.push("", `### ${blocker.title} (${blocker.id})`);
      if (blocker.description?.trim()) {
        lines.push(blocker.description.trim());
      }
      if (blocker.notes?.trim()) {
        lines.push("", blocker.notes.trim());
      }
    }
  }
  return lines.join(`
`).trim();
}

class BeadsClient {
  available;
  constructor() {
    this.available = BeadsClient.checkAvailable();
    if (!this.available) {
      console.warn("[specialists] bd CLI not found — beads tracking disabled");
    }
  }
  static checkAvailable() {
    const result = spawnSync2("bd", ["--version"], { stdio: "ignore" });
    return result.status === 0;
  }
  isAvailable() {
    return this.available;
  }
  createBead(specialistName) {
    if (!this.available)
      return null;
    const result = spawnSync2("bd", ["q", `specialist:${specialistName}`, "--type", "task", "--labels", "specialist"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0)
      return null;
    const id = result.stdout?.trim();
    return id || null;
  }
  readBead(id) {
    if (!this.available || !id)
      return null;
    const result = spawnSync2("bd", ["show", id, "--json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    if (result.error || result.status !== 0 || !result.stdout?.trim())
      return null;
    try {
      const parsed = JSON.parse(result.stdout);
      const bead = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!bead || typeof bead !== "object" || typeof bead.id !== "string" || typeof bead.title !== "string")
        return null;
      return bead;
    } catch (err) {
      console.warn(`[specialists] readBead: JSON parse failed for id=${id}: ${err}`);
      return null;
    }
  }
  getCompletedBlockers(id, depth = 1) {
    if (!this.available || !id || depth < 1)
      return [];
    const result = spawnSync2("bd", ["dep", "list", id, "--json"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    if (result.error || result.status !== 0 || !result.stdout?.trim())
      return [];
    let deps;
    try {
      deps = JSON.parse(result.stdout);
      if (!Array.isArray(deps))
        return [];
    } catch {
      return [];
    }
    const blockers = deps.filter((d) => d.dependency_type === "blocks" && d.status === "closed");
    const records = [];
    for (const dep of blockers) {
      const record = this.readBead(dep.id);
      if (record) {
        records.push(record);
        if (depth > 1) {
          records.push(...this.getCompletedBlockers(dep.id, depth - 1));
        }
      }
    }
    return records;
  }
  addDependency(trackingBeadId, inputBeadId) {
    if (!this.available || !trackingBeadId || !inputBeadId)
      return;
    spawnSync2("bd", ["dep", "add", trackingBeadId, inputBeadId], { stdio: "ignore" });
  }
  closeBead(id, status, durationMs, model) {
    if (!this.available || !id)
      return;
    const reason = `${status}, ${Math.round(durationMs)}ms, ${model}`;
    spawnSync2("bd", ["close", id, "-r", reason], { stdio: "ignore" });
  }
  closeBeadIfInProgress(id, reason) {
    if (!this.available || !id)
      return false;
    const bead = this.readBead(id);
    if (!bead)
      return false;
    if (bead.status !== "open" && bead.status !== "in_progress")
      return false;
    const result = spawnSync2("bd", ["close", id, "-r", reason], { stdio: "ignore" });
    return result.status === 0;
  }
  updateBeadNotes(id, notes) {
    if (!this.available || !id || !notes)
      return { ok: false, error: "beads unavailable or empty payload" };
    const result = spawnSync2("bd", ["update", id, "--append-notes", notes], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      return { ok: false, error: stderr || `bd update failed with exit code ${result.status}` };
    }
    return { ok: true };
  }
  auditBead(id, toolName, model, exitCode) {
    if (!this.available || !id)
      return;
    spawnSync2("bd", [
      "audit",
      "record",
      "--kind",
      "tool_call",
      "--tool-name",
      toolName,
      "--model",
      model,
      "--issue-id",
      id,
      "--exit-code",
      String(exitCode)
    ], { stdio: "ignore" });
  }
}

// src/specialist/payload-measure.ts
function estimateTokens3(text) {
  if (!text)
    return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
function measureUtf8Bytes(text) {
  return Buffer.byteLength(text, "utf8");
}
function measurePayloadComponent(kind, name, text) {
  return { kind, name, tokens: estimateTokens3(text), bytes: measureUtf8Bytes(text) };
}

// src/specialist/task-prompt.ts
var MANDATORY_RULES_TOKEN_LIMIT = 2400;
var SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var OPTIONALLY_ABSENT_PLACEHOLDERS = new Set([
  "bead_context",
  "gitnexus_summary",
  "obligations_diff",
  "resolved_tool_contract",
  "reused_worktree_awareness",
  "reviewed_job_id",
  "writer_diff",
  "writer_job_id"
]);

class TemplatePlaceholderError extends Error {
  unresolved;
  constructor(unresolved) {
    super(`task_template references unresolved placeholder(s): ${unresolved.map((n) => `$${n}`).join(", ")}`);
    this.name = "TemplatePlaceholderError";
    this.unresolved = unresolved;
  }
}
function deriveSkillName(path) {
  const base = basename(path);
  if (base === "SKILL.md")
    return basename(dirname6(path));
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}
function buildSkillPrefix(specialist, surface) {
  const paths = specialist.skills?.paths ?? [];
  if (paths.length === 0)
    return "";
  const seen = new Set;
  const names = [];
  for (const p of paths) {
    const n = deriveSkillName(p);
    if (!SKILL_NAME_PATTERN.test(n)) {
      throw new Error("Invalid skill name derived from skills.paths");
    }
    if (seen.has(n))
      continue;
    seen.add(n);
    names.push(n);
  }
  if (names.length === 0)
    return "";
  if (surface === "claude")
    return `${names.map((n) => `/${n}`).join(`
`)}

`;
  if (surface === "codex")
    return `${names.map((n) => `$${n}`).join(" ")}

`;
  return `${names.map((n) => `/skill:${n}`).join(" ")}

`;
}
function buildBeadBoundaryInstruction(cwd, worktreeBoundary) {
  const boundary = worktreeBoundary?.trim() || cwd;
  return [
    "## Runtime Boundary Rules",
    `- Current cwd: ${cwd}`,
    `- Assigned worktree boundary: ${boundary}`,
    "- Stay inside current cwd / assigned worktree unless the task explicitly says otherwise.",
    "- Do NOT run `cd` outside the current cwd / assigned worktree.",
    "- Do NOT use absolute paths outside the current cwd / assigned worktree.",
    "- Do NOT broad-search /home, repo root, or unrelated paths when evidence is missing.",
    "- If required evidence is missing inside the current scope, STOP immediately, report exactly what is missing, and ask for the artifact or clarification instead of widening search."
  ].join(`
`);
}
function renderTaskPrompt(input) {
  const { specialist, cwd, beadId } = input;
  const prompt = specialist.prompt;
  const bare = specialist.execution?.bare ?? false;
  const completedBlockers = input.completedBlockers ?? [];
  const beadContextText = input.bead ? buildBeadContext(input.bead, completedBlockers) : "";
  const beadContextOwn = beadContextText ? measurePayloadComponent("bead_context", "own", beadContextText) : null;
  const beadContextParent = input.bead?.parent?.trim() ? measurePayloadComponent("bead_context", "parent", input.bead.parent.trim()) : null;
  const beadContextBlockers = completedBlockers.map((blocker) => measurePayloadComponent("bead_context", blocker.id, buildBeadContext(blocker, [])));
  const resolvedPrompt = beadId && beadContextText ? `${beadContextText}

${buildBeadBoundaryInstruction(cwd, input.worktreeBoundary)}`.trim() : input.fallbackPrompt?.() ?? "";
  const lineageVariables = {
    ...input.reusedFromJobId ? { reused_from_job_id: input.reusedFromJobId } : {},
    ...input.worktreeOwnerJobId ? { worktree_owner_job_id: input.worktreeOwnerJobId } : {},
    ...input.gitnexusSummary ? { gitnexus_summary: input.gitnexusSummary } : {}
  };
  const beadVariables = beadId ? { bead_context: resolvedPrompt, bead_id: beadId } : {};
  const beadTemplateVariables = {
    prompt: resolvedPrompt,
    bead_id: beadId ?? "",
    ...lineageVariables
  };
  const variables = {
    prompt: resolvedPrompt,
    cwd,
    pre_script_output: input.preScriptOutput ?? "",
    bead_id: beadId ?? "",
    ...lineageVariables,
    ...input.variables ?? {},
    ...beadVariables
  };
  for (const name of OPTIONALLY_ABSENT_PLACEHOLDERS) {
    if (variables[name] === undefined)
      variables[name] = "";
  }
  const unresolvedTokens = extractTemplateTokens(prompt.task_template).filter((name) => variables[name] === undefined);
  if (unresolvedTokens.length > 0)
    throw new TemplatePlaceholderError(unresolvedTokens);
  let renderedTask = renderTemplate(prompt.task_template, variables);
  const taskTemplateComponent = measurePayloadComponent("task_template", "task_template", renderedTask);
  let mandatoryRulesBlock = "";
  let mandatoryRules = null;
  let mandatoryRulesError = null;
  try {
    if (!bare) {
      mandatoryRules = buildMandatoryRulesInjection({ cwd, specialist }, MANDATORY_RULES_TOKEN_LIMIT);
      mandatoryRulesBlock = mandatoryRules.block;
      if (mandatoryRulesBlock.trim())
        renderedTask = `${renderedTask}

${mandatoryRulesBlock}`;
    }
  } catch (error) {
    if (error instanceof MandatoryRulesBudgetError)
      throw error;
    mandatoryRulesError = String(error);
    console.warn(`[specialist runner] Skipping MANDATORY_RULES injection: ${mandatoryRulesError}`);
  }
  if (!bare && input.appendExecutionContext) {
    renderedTask = input.appendExecutionContext(renderedTask, cwd, variables);
  }
  const skillPrefix = buildSkillPrefix(specialist, input.surface ?? "pi");
  if (skillPrefix)
    renderedTask = `${skillPrefix}${renderedTask}`;
  return {
    initial_prompt: renderedTask,
    prompt_hash: createHash3("sha256").update(renderedTask).digest("hex").slice(0, 16),
    skillPrefix,
    taskTemplateComponent,
    beadContextOwn,
    beadContextParent,
    beadContextBlockers,
    mandatoryRules,
    mandatoryRulesBlock,
    mandatoryRulesError,
    variables,
    beadTemplateVariables,
    beadContextText,
    resolvedPrompt
  };
}

// src/utils/circuitBreaker.ts
class CircuitBreaker {
  states = new Map;
  threshold;
  cooldownMs;
  constructor(options = {}) {
    this.threshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60000;
  }
  getState(backend) {
    const entry = this.states.get(backend);
    if (!entry)
      return "CLOSED";
    if (entry.state === "OPEN" && Date.now() - entry.openedAt > this.cooldownMs) {
      entry.state = "HALF_OPEN";
    }
    return entry.state;
  }
  isAvailable(backend) {
    return this.getState(backend) !== "OPEN";
  }
  recordSuccess(backend) {
    this.states.set(backend, { state: "CLOSED", failures: 0 });
  }
  recordFailure(backend) {
    const entry = this.states.get(backend) ?? { state: "CLOSED", failures: 0 };
    entry.failures++;
    if (entry.failures >= this.threshold) {
      entry.state = "OPEN";
      entry.openedAt = Date.now();
    }
    this.states.set(backend, entry);
  }
}

// src/specialist/system-prompt.ts
import { execSync as execSync2 } from "node:child_process";
import { existsSync as existsSync9 } from "node:fs";
import { resolve as resolve7 } from "node:path";
var OUTPUT_TYPE_GUIDANCE = {
  codegen: "- Codegen focus: include exact file paths, symbols touched, and implementation outcomes.",
  analysis: "- Analysis focus: include architecture understanding and evidence-backed findings.",
  review: "- Review focus: include severity-ranked findings with clear merge/readiness recommendation.",
  synthesis: "- Synthesis focus: consolidate findings into decisions and clear next steps.",
  orchestration: "- Orchestration focus: include actions, blockers, routing rationale, and rehydration state.",
  workflow: "- Workflow focus: include procedural state transitions and operational checkpoints.",
  research: "- Research focus: include sources checked, confidence, and final recommendations."
};
function buildOutputContractInstruction(responseFormat, outputType, outputSchema) {
  if (responseFormat === "text")
    return "";
  const lines = ["## Output Contract"];
  if (responseFormat === "markdown") {
    lines.push("Respond using markdown with canonical sections (include when applicable):", "- `## Summary`", "- `## Status`", "- `## Changes`", "- `## Verification`", "- `## Risks`", "- `## Follow-ups`", "- `## Beads`", "Optional sections when relevant:", "- `## Architecture`", "- `## Acceptance Criteria`", "- `## Machine-readable block`", "Do not impose artificial bullet limits — prioritize completeness and clarity.");
  } else {
    lines.push("Respond with a single valid JSON object only.", "Do not wrap JSON in markdown fences, headers, or prose.");
  }
  if (outputType !== "custom") {
    lines.push(`Output archetype: \`${outputType}\``);
    lines.push(OUTPUT_TYPE_GUIDANCE[outputType]);
  }
  if (outputSchema) {
    lines.push("Structure your output to match this schema:", "```json", JSON.stringify(outputSchema, null, 2), "```");
    if (responseFormat === "markdown") {
      lines.push("MANDATORY: include `## Machine-readable block` with exactly one JSON object in a single ```json fenced block.", "The machine-readable JSON block is canonical and must match the schema.");
    }
  }
  return `

${lines.join(`
`)}`;
}
function sanitizeBeadIdForPrompt(beadId) {
  const withoutControlChars = beadId.replace(/[\x00-\x1F\x7F]/g, "");
  const withoutBackticks = withoutControlChars.replace(/`/g, "");
  return withoutBackticks.replace(/[^A-Za-z0-9-]/g, "");
}
function defaultHasGitnexusIndex(cwd) {
  return existsSync9(resolve7(cwd, ".gitnexus/meta.json"));
}
function defaultQueryGitnexusSymbol(cwd, symbol) {
  try {
    const raw = execSync2(`gitnexus context --repo specialists ${JSON.stringify(symbol)}`, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parsed = JSON.parse(raw);
    if (parsed.status !== "found" || !parsed.symbol?.name)
      return;
    const callers = (parsed.incoming?.calls ?? []).slice(0, 3).map((call) => call.name).filter(Boolean);
    const callees = (parsed.outgoing?.calls ?? []).slice(0, 3).map((call) => call.name).filter(Boolean);
    const processes = (parsed.processes ?? []).slice(0, 2).map((proc) => proc.name).filter(Boolean);
    return `- ${parsed.symbol.name} (${parsed.symbol.filePath ?? "unknown file"})
` + `  callers: ${callers.length > 0 ? callers.join(", ") : "none"}
` + `  callees: ${callees.length > 0 ? callees.join(", ") : "none"}
` + `  processes: ${processes.length > 0 ? processes.join(", ") : "none"}`;
  } catch {
    return;
  }
}
function defaultReadBeadForMemory(beadId) {
  return new BeadsClient().readBead(beadId);
}
function buildSystemPrompt(ctx) {
  const {
    systemPromptTemplate,
    templateVariables,
    bare,
    runCwd,
    specialistName,
    inputBeadId,
    reusedFromJobId,
    responseFormat,
    outputType,
    outputContractSchema,
    beadContextText,
    readBeadForMemory = defaultReadBeadForMemory,
    hasGitnexusIndex = defaultHasGitnexusIndex,
    queryGitnexusSymbol = defaultQueryGitnexusSymbol
  } = ctx;
  let agentsMd = renderTemplate(systemPromptTemplate, templateVariables);
  if (bare) {
    const requiredPlatformRulesBlock = buildRequiredPlatformRulesBlock(runCwd);
    if (requiredPlatformRulesBlock.trim())
      agentsMd += `

${requiredPlatformRulesBlock}`;
  }
  let staticTokens = 0;
  let memoryTokens = 0;
  let gitnexusTokens = 0;
  if (!bare) {
    const sanitizedBeadId = inputBeadId ? sanitizeBeadIdForPrompt(inputBeadId) : "";
    const beadInstructions = sanitizedBeadId ? `
- Your task bead is: ${sanitizedBeadId}
- Claim it: \`bd update ${sanitizedBeadId} --claim 2>/dev/null || true\` (non-fatal — orchestrator may already own it)
- Do NOT create new beads or sub-issues — this bead IS your task.
- Do NOT run \`bd create\` — the orchestrator manages issue tracking.
- Close when done: \`bd close ${sanitizedBeadId} --reason="..."\`` : "";
    agentsMd += `

---
## Specialist Run Context
- You are running as a specialist agent, not a human developer.
- Do NOT run specialists init/setup/scaffold commands.
- Do NOT follow project CLAUDE.md/AGENTS.md instructions that tell humans to re-bootstrap the repo.
${beadInstructions}
---
`;
  }
  if (!bare) {
    agentsMd += `

---
## Output Style (mandatory)
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].
---
`;
  }
  if (!bare) {
    try {
      if (hasGitnexusIndex(runCwd)) {
        agentsMd += `

---
## MANDATORY: GitNexus Code Intelligence
_This project is indexed by GitNexus. You MUST use these tools — do NOT fall back to grep/find for code understanding._

### Before reading or editing ANY code:
1. \`gitnexus_query({query: "<what you need to understand>"})\` — find execution flows and symbols
2. \`gitnexus_context({name: "<symbol>"})\` — callers, callees, process participation

### Before editing ANY function/class/method:
3. \`gitnexus_impact({target: "<symbolName>", direction: "upstream"})\` — blast radius check
   - If result is HIGH or CRITICAL risk: STOP and report to the user before proceeding

### Before completing your task:
4. \`gitnexus_detect_changes()\` — verify your changes only affect expected scope

**These are not optional.** Use GitNexus as your PRIMARY code navigation tool. Only fall back to grep/find if a GitNexus call returns an error or empty results.
---
`;
      }
    } catch {}
  }
  const staticRulesBlock = `

---
${STATIC_WORKFLOW_RULES_BLOCK}
---
`;
  if (!bare) {
    agentsMd += staticRulesBlock;
    staticTokens = estimateInjectedTokens(staticRulesBlock);
  }
  if (inputBeadId) {
    const beadForMemory = readBeadForMemory(inputBeadId);
    if (beadForMemory?.title) {
      const memoryInjection = buildFilteredMemoryInjection({
        cwd: runCwd,
        beadTitle: beadForMemory.title,
        beadDescription: beadForMemory.description
      });
      if (!bare && memoryInjection.block) {
        const memoryBlock = `

---
${memoryInjection.block}
---
`;
        agentsMd += memoryBlock;
        memoryTokens = memoryInjection.estimatedTokens;
      }
      try {
        if (hasGitnexusIndex(runCwd)) {
          const symbolCandidates = (beadForMemory.title.match(/\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g) ?? []).slice(0, 2);
          const summaries = [];
          for (const symbol of symbolCandidates) {
            const summary = queryGitnexusSymbol(runCwd, symbol);
            if (summary)
              summaries.push(summary);
          }
          if (!bare && summaries.length > 0) {
            const gitnexusBlock = `

---
## GitNexus Pre-query Snapshot
${summaries.join(`
`)}
---
`;
            agentsMd += gitnexusBlock;
            gitnexusTokens = estimateInjectedTokens(gitnexusBlock);
          }
        }
      } catch {}
    }
  }
  if (!bare && specialistName === "reviewer" && reusedFromJobId) {
    agentsMd += '\n\nReviewer patch retrieval: run `git diff master..HEAD -- ":!dist/" ":!*.map"` inside reused worktree. Find worktree path via `sp ps ${reviewed_job_id}` first.\n';
  }
  if (!bare) {
    agentsMd += buildOutputContractInstruction(responseFormat, outputType, outputContractSchema);
  }
  const components = [
    measurePayloadComponent("system_prompt", "system_prompt", agentsMd)
  ];
  if (staticTokens > 0)
    components.push(measurePayloadComponent("memory", "static", STATIC_WORKFLOW_RULES_BLOCK));
  if (memoryTokens > 0)
    components.push(measurePayloadComponent("memory", "dynamic", beadContextText || ""));
  if (gitnexusTokens > 0)
    components.push(measurePayloadComponent("memory", "gitnexus", agentsMd.includes("GitNexus") ? "GitNexus" : ""));
  return {
    text: agentsMd,
    components,
    tokens: { static: staticTokens, memory: memoryTokens, gitnexus: gitnexusTokens }
  };
}

// src/specialist/runner.ts
import { execSync as execSync3, spawnSync as spawnSync3 } from "node:child_process";
import { existsSync as existsSync10, readFileSync as readFileSync5 } from "node:fs";
import { basename as basename2, resolve as resolve8 } from "node:path";
import { homedir as homedir3 } from "node:os";
function sanitizeScriptName(name) {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f"\\<>]/g, "").slice(0, 128);
  return /^[A-Za-z0-9:][A-Za-z0-9._:-]{0,127}$/.test(cleaned) ? cleaned : "unknown";
}
var SCRIPT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
function capStream(value, limitBytes = SCRIPT_OUTPUT_LIMIT_BYTES) {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= limitBytes)
    return value;
  return buf.subarray(0, limitBytes).toString("utf8");
}
function runScript(command, cwd) {
  const run = (command ?? "").trim();
  if (!run) {
    return { name: "unknown", output: "Missing script command (expected `run` or legacy `path`).", stderr: "", exitCode: 1 };
  }
  const scriptName = sanitizeScriptName(basename2(run.split(" ")[0]));
  const result = spawnSync3(run, {
    encoding: "utf8",
    timeout: 30000,
    cwd,
    shell: true,
    maxBuffer: SCRIPT_OUTPUT_LIMIT_BYTES
  });
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const output = capStream(result.stdout ?? "");
  const stderr = capStream(result.stderr ?? "");
  if (exitCode === 0 && !result.error) {
    return { name: scriptName, output, stderr, exitCode: 0 };
  }
  const rawErrorCode = result.error?.code;
  const spawnError = typeof rawErrorCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawErrorCode) ? rawErrorCode : result.error ? "SPAWN_ERROR" : undefined;
  const notes = [stderr.trim(), spawnError ? `spawn error: ${spawnError}` : ""].filter(Boolean).join(`
`);
  return {
    name: scriptName,
    output,
    stderr: notes,
    exitCode,
    ...result.signal ? { signal: result.signal } : {},
    ...spawnError ? { spawnError } : {}
  };
}
function findRequiredPreScriptFailure(scripts, results) {
  for (let i = 0;i < scripts.length; i += 1) {
    const script = scripts[i];
    if (script.phase !== "pre" || script.required !== true)
      continue;
    const result = results[i];
    if (result && result.exitCode !== 0) {
      return {
        name: result.name,
        exitCode: result.exitCode,
        stdout: result.output,
        stderr: result.stderr,
        ...result.signal ? { signal: result.signal } : {},
        ...result.spawnError ? { spawnError: result.spawnError } : {}
      };
    }
  }
  return null;
}
var PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES = 4096;
function sanitizeDiagnostic(text, limitBytes) {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  if (Buffer.byteLength(clean, "utf8") <= limitBytes)
    return clean;
  let slice = clean.slice(0, limitBytes);
  while (Buffer.byteLength(slice, "utf8") > limitBytes)
    slice = slice.slice(0, -1);
  return `${slice}
... (truncated)`;
}
function formatRequiredPreScriptFailure(failure) {
  const context = failure.signal ? ` (signal ${failure.signal})` : failure.spawnError ? ` (${failure.spawnError})` : "";
  return [
    `Required pre-script '${failure.name}' failed with exit code ${failure.exitCode}${context}.`,
    "The run was aborted before the model session started; no model fallback or retry is performed.",
    `--- stdout (bounded to ${PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES} bytes) ---`,
    sanitizeDiagnostic(failure.stdout, PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES),
    `--- stderr (bounded to ${PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES} bytes) ---`,
    sanitizeDiagnostic(failure.stderr, PRE_SCRIPT_DIAGNOSTIC_LIMIT_BYTES)
  ].join(`
`);
}
function formatScriptOutput(results) {
  const withOutput = results.filter((r) => r.output.trim());
  if (withOutput.length === 0)
    return "";
  const blocks = withOutput.map((r) => {
    const status = r.exitCode === 0 ? "" : ` exit_code="${r.exitCode}"`;
    return `<script name="${r.name}"${status}>
${r.output.trim()}
</script>`;
  }).join(`
`);
  return `<pre_flight_context>
${blocks}
</pre_flight_context>`;
}
function resolvePath2(p) {
  return p.startsWith("~/") ? resolve8(homedir3(), p.slice(2)) : resolve8(p);
}
function commandExists(cmd) {
  const result = spawnSync3("which", [cmd], { stdio: "ignore" });
  return result.status === 0;
}
var SHELL_BUILTINS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "in",
  "function",
  "return",
  "break",
  "continue",
  ":",
  ".",
  "true",
  "false",
  "[",
  "[[",
  "{",
  "("
]);
function validateShebang(filePath, errors) {
  try {
    const head = readFileSync5(filePath, "utf-8").slice(0, 120);
    if (!head.startsWith("#!"))
      return;
    const shebang = head.split(`
`)[0].toLowerCase();
    const typos = [
      [/pytho[^n]|pyton|pyhon/, "python"],
      [/nod[^e]b/, "node"],
      [/bsh$|bas$/, "bash"],
      [/rub[^y]/, "ruby"]
    ];
    for (const [pattern, correct] of typos) {
      if (pattern.test(shebang)) {
        errors.push(`  ✗ ${filePath}: shebang looks wrong — did you mean '${correct}'? (got: ${shebang})`);
      }
    }
  } catch {}
}
var PERMISSION_GATED_TOOLS = {
  bash: ["LOW", "MEDIUM", "HIGH"],
  edit: ["MEDIUM", "HIGH"],
  write: ["HIGH"]
};
function isToolAvailable(tool, permissionLevel) {
  const normalized = permissionLevel.toUpperCase();
  const gatedLevels = PERMISSION_GATED_TOOLS[tool.toLowerCase()];
  if (!gatedLevels)
    return true;
  return gatedLevels.includes(normalized);
}
function validateBeforeRun(spec, permissionLevel, resolvedToolContract) {
  const errors = [];
  const warnings = [];
  for (const p of spec.specialist.skills?.paths ?? []) {
    const abs = resolvePath2(p);
    if (!existsSync10(abs)) {
      errors.push(`  ✗ skills.paths: skill not found: ${p}
` + `    resolved to: ${abs}
` + `    canonical global skills live in ~/.xtrm/skills/default/<skill>/`);
    }
  }
  for (const script of spec.specialist.skills?.scripts ?? []) {
    const run = script.run ?? script.path;
    if (!run)
      continue;
    const isFilePath = run.startsWith("./") || run.startsWith("../") || run.startsWith("/") || run.startsWith("~/");
    if (isFilePath) {
      const abs = resolvePath2(run);
      if (!existsSync10(abs)) {
        errors.push(`  ✗ skills.scripts: script not found: ${run}`);
      } else {
        validateShebang(abs, errors);
      }
    } else {
      const binary = run.split(" ")[0];
      if (binary && !SHELL_BUILTINS.has(binary) && !commandExists(binary)) {
        errors.push(`  ✗ skills.scripts: command not found on PATH: ${binary}`);
      }
    }
  }
  for (const cmd of spec.specialist.capabilities?.external_commands ?? []) {
    if (!commandExists(cmd)) {
      errors.push(`  ✗ capabilities.external_commands: not found on PATH: ${cmd}`);
    }
  }
  const exposingExtensions = (resolvedToolContract?.exposedExtensionSources.length ?? 0) > 0;
  for (const tool of spec.specialist.capabilities?.required_tools ?? []) {
    if (!isToolAvailable(tool, permissionLevel)) {
      errors.push(`  ✗ capabilities.required_tools: tool "${tool}" requires higher permission than "${permissionLevel}"`);
      continue;
    }
    if (resolvedToolContract && !resolvedToolContract.toolsList.some((availableTool) => availableTool.toLowerCase() === tool.toLowerCase())) {
      if (exposingExtensions) {
        warnings.push(`capabilities.required_tools: tool "${tool}" is expected from an enabled extension source; it is not in the native contract (${resolvedToolContract.toolsFlag || "(none)"})`);
      } else {
        errors.push(`  ✗ capabilities.required_tools: tool "${tool}" missing from resolved runtime contract (${resolvedToolContract.toolsFlag || "(none)"})`);
      }
    }
  }
  if (warnings.length > 0) {
    process.stderr.write(`[specialists] pre-run warnings:
${warnings.join(`
`)}
`);
  }
  if (errors.length > 0) {
    throw new Error(`Specialist pre-run validation failed:
${errors.join(`
`)}`);
  }
}

// src/specialist/timeline-events.ts
var TIMELINE_EVENT_TYPES = {
  RUN_START: "run_start",
  META: "meta",
  PAYLOAD_BREAKDOWN: "payload_breakdown",
  THINKING: "thinking",
  TOOL: "tool",
  TEXT: "text",
  MESSAGE: "message",
  TURN: "turn",
  STATUS_CHANGE: "status_change",
  RUN_COMPLETE: "run_complete",
  STALE_WARNING: "stale_warning",
  TOKEN_USAGE: "token_usage",
  FINISH_REASON: "finish_reason",
  TURN_SUMMARY: "turn_summary",
  COMPACTION: "compaction",
  RETRY: "retry",
  MODEL_CHANGE: "model_change",
  EXTENSION_ERROR: "extension_error",
  ERROR: "error",
  AUTO_COMMIT_SUCCESS: "auto_commit_success",
  AUTO_COMMIT_SKIPPED: "auto_commit_skipped",
  AUTO_COMMIT_FAILED: "auto_commit_failed",
  COMMAND_COMPLETED: "command_completed",
  COMMAND_FAILED: "command_failed",
  REVIEW_VERDICT_PASS: "review_verdict_pass",
  REVIEW_VERDICT_PARTIAL: "review_verdict_partial",
  REVIEW_VERDICT_FAIL: "review_verdict_fail",
  REVIEW_VERDICT_WAIVED: "review_verdict_waived",
  CHAIN_READY_FOR_REVIEW: "chain_ready_for_review",
  CHAIN_FINALIZED: "chain_finalized",
  WORKTREE_MERGED: "worktree_merged",
  CONTROL_SIGNAL: "control_signal",
  DONE: "done",
  AGENT_END: "agent_end"
};
var TOOL_RESULT_SUMMARY_LIMIT = 500;
function summarizeToolResult(resultContent) {
  if (!resultContent)
    return;
  const compact = resultContent.trim();
  if (!compact)
    return;
  if (compact.length <= TOOL_RESULT_SUMMARY_LIMIT)
    return compact;
  return `${compact.slice(0, TOOL_RESULT_SUMMARY_LIMIT)}…`;
}
function mapCallbackEventToTimelineEvent(callbackEvent, context) {
  const t = Date.now();
  switch (callbackEvent) {
    case "payload_breakdown":
      return { t, type: "payload_breakdown", payload_breakdown: context.payloadBreakdown ?? { components: [], totals: { tokens: 0, bytes: 0 } } };
    case "thinking":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.THINKING,
        ...context.charCount !== undefined ? { char_count: context.charCount } : {}
      };
    case "tool_execution_start":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.TOOL,
        tool: context.tool ?? "unknown",
        phase: "start",
        tool_call_id: context.toolCallId,
        ...context.toolCallId ? {} : { uncorrelated: true },
        args: context.args,
        started_at: new Date(t).toISOString()
      };
    case "tool_execution_update":
    case "tool_execution":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.TOOL,
        tool: context.tool ?? "unknown",
        phase: "update",
        tool_call_id: context.toolCallId,
        ...context.toolCallId ? {} : { uncorrelated: true }
      };
    case "tool_execution_end": {
      const resultSummary = summarizeToolResult(context.resultContent);
      return {
        t,
        type: TIMELINE_EVENT_TYPES.TOOL,
        tool: context.tool ?? "unknown",
        phase: "end",
        tool_call_id: context.toolCallId,
        ...context.toolCallId ? {} : { uncorrelated: true },
        is_error: context.isError,
        ...resultSummary ? { result_summary: resultSummary } : {},
        ...context.resultRaw ? { result_raw: context.resultRaw } : {}
      };
    }
    case "message_start_assistant":
      return { t, type: TIMELINE_EVENT_TYPES.MESSAGE, phase: "start", role: "assistant" };
    case "message_end_assistant":
      return { t, type: TIMELINE_EVENT_TYPES.MESSAGE, phase: "end", role: "assistant" };
    case "message_start_tool_result":
      return { t, type: TIMELINE_EVENT_TYPES.MESSAGE, phase: "start", role: "toolResult" };
    case "message_end_tool_result":
      return { t, type: TIMELINE_EVENT_TYPES.MESSAGE, phase: "end", role: "toolResult" };
    case "turn_start":
      return { t, type: TIMELINE_EVENT_TYPES.TURN, phase: "start" };
    case "turn_end":
      return { t, type: TIMELINE_EVENT_TYPES.TURN, phase: "end" };
    case "auto_compaction_start":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.COMPACTION,
        phase: "start",
        ...context.compaction?.tokensBefore !== undefined ? { tokens_before: context.compaction.tokensBefore } : {},
        ...context.compaction?.summary ? { summary: context.compaction.summary } : {},
        ...context.compaction?.firstKeptEntryId ? { first_kept_entry_id: context.compaction.firstKeptEntryId } : {}
      };
    case "auto_compaction_end":
    case "auto_compaction":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.COMPACTION,
        phase: "end",
        ...context.compaction?.tokensBefore !== undefined ? { tokens_before: context.compaction.tokensBefore } : {},
        ...context.compaction?.summary ? { summary: context.compaction.summary } : {},
        ...context.compaction?.firstKeptEntryId ? { first_kept_entry_id: context.compaction.firstKeptEntryId } : {}
      };
    case "auto_retry_start":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.RETRY,
        phase: "start",
        ...context.retry?.attempt !== undefined ? { attempt: context.retry.attempt } : {},
        ...context.retry?.maxAttempts !== undefined ? { max_attempts: context.retry.maxAttempts } : {},
        ...context.retry?.delayMs !== undefined ? { delay_ms: context.retry.delayMs } : {},
        ...context.retry?.errorMessage ? { error_message: context.retry.errorMessage } : {}
      };
    case "auto_retry_end":
    case "auto_retry":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.RETRY,
        phase: "end",
        ...context.retry?.attempt !== undefined ? { attempt: context.retry.attempt } : {},
        ...context.retry?.maxAttempts !== undefined ? { max_attempts: context.retry.maxAttempts } : {},
        ...context.retry?.delayMs !== undefined ? { delay_ms: context.retry.delayMs } : {},
        ...context.retry?.errorMessage ? { error_message: context.retry.errorMessage } : {}
      };
    case "set_model":
    case "cycle_model":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.MODEL_CHANGE,
        action: callbackEvent,
        ...context.modelChange?.model ? { model: context.modelChange.model } : {},
        ...context.modelChange?.previousModel ? { previous_model: context.modelChange.previousModel } : {}
      };
    case "extension_error":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.EXTENSION_ERROR,
        ...context.extensionError?.extension ? { extension: context.extensionError.extension } : {},
        ...context.extensionError?.errorMessage ? { error_message: context.extensionError.errorMessage } : {}
      };
    case "api_error":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.ERROR,
        source: context.apiError?.source ?? "rpc",
        error_message: context.apiError?.errorMessage ?? "Unknown API error"
      };
    case "memory_injection":
      return {
        t,
        type: TIMELINE_EVENT_TYPES.META,
        model: "memory_injection",
        backend: "injected",
        ...context.memoryInjection ? { memory_injection: context.memoryInjection } : {}
      };
    case "meta": {
      const payload = context.metaPayload;
      return {
        t,
        type: TIMELINE_EVENT_TYPES.META,
        model: payload?.model ?? "meta",
        backend: payload?.backend ?? "injected",
        ...payload?.source ? { source: payload.source } : {},
        ...payload?.data ? { data: payload.data } : {}
      };
    }
    case "text":
      return null;
    case "agent_end":
    case "message_done":
    case "done":
      return null;
    default:
      return null;
  }
}
function createRunStartEvent(specialist, beadId, startupSnapshot) {
  return {
    t: Date.now(),
    type: TIMELINE_EVENT_TYPES.RUN_START,
    specialist,
    bead_id: beadId,
    ...startupSnapshot ? { startup_snapshot: startupSnapshot } : {}
  };
}
function createMetaEvent(model, backend) {
  return {
    t: Date.now(),
    type: TIMELINE_EVENT_TYPES.META,
    model,
    backend
  };
}
function createTokenUsageEvent(token_usage, source) {
  return {
    t: Date.now(),
    type: TIMELINE_EVENT_TYPES.TOKEN_USAGE,
    token_usage,
    source
  };
}
function createFinishReasonEvent(finish_reason, source) {
  return {
    t: Date.now(),
    type: TIMELINE_EVENT_TYPES.FINISH_REASON,
    finish_reason,
    source
  };
}
function createTurnSummaryEvent(turn_index, token_usage, finish_reason, textContent, contextPct, contextHealth) {
  return {
    t: Date.now(),
    type: TIMELINE_EVENT_TYPES.TURN_SUMMARY,
    turn_index,
    ...token_usage ? { token_usage } : {},
    ...finish_reason ? { finish_reason } : {},
    ...textContent ? { text_content: textContent } : {},
    ...contextPct !== undefined ? { context_pct: contextPct } : {},
    ...contextHealth ? { context_health: contextHealth } : {}
  };
}
function createRunCompleteEvent(status, elapsed_s, options) {
  return {
    t: Date.now(),
    type: TIMELINE_EVENT_TYPES.RUN_COMPLETE,
    status,
    elapsed_s,
    ...options
  };
}

// src/specialist/script-runner.ts
class CompatGuardError extends Error {
  field;
  constructor(field, message) {
    super(message);
    this.field = field;
    this.name = "CompatGuardError";
  }
}
function normalizePath(path, baseDir) {
  if (isAbsolute2(path))
    return path;
  return resolve9(baseDir ?? process.cwd(), path);
}
function isPathWithinRoot(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || rel.length > 0 && !rel.startsWith("..") && !isAbsolute2(rel);
}
function canonicalizeSkillRoot(root, baseDir) {
  try {
    const normalized = normalizePath(root, baseDir);
    lstatSync2(normalized);
    const canonical = realpathSync(normalized);
    const stat = lstatSync2(canonical);
    if (!stat.isDirectory())
      throw new Error("not a directory");
    accessSync(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch {
    throw new CompatGuardError("skills.paths", "--allow-skills-roots entry is not usable; rejected");
  }
}
function canonicalizeSkillPath(field, path, baseDir) {
  try {
    const normalized = normalizePath(path, baseDir);
    lstatSync2(normalized);
    const canonical = realpathSync(normalized);
    const stat = lstatSync2(canonical);
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error("not a file or directory");
    accessSync(canonical, stat.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
    if (stat.isDirectory()) {
      const skillFile = join7(canonical, "SKILL.md");
      const skillStat = lstatSync2(skillFile);
      if (skillStat.isSymbolicLink() || !skillStat.isFile())
        throw new Error("invalid SKILL.md");
      accessSync(skillFile, constants.R_OK);
    }
    return canonical;
  } catch {
    throw new CompatGuardError(field, "skill path is not usable; rejected");
  }
}
function assertSkillPathWithinRoots(field, path, canonicalRoots, baseDir) {
  const candidate = canonicalizeSkillPath(field, path, baseDir);
  if (!canonicalRoots.some((root) => isPathWithinRoot(candidate, root))) {
    throw new CompatGuardError(field, "skill path is not under any --allow-skills-roots entry");
  }
  return candidate;
}
function hasUnsubstitutedVariables(template, variables) {
  const matches = template.match(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? [];
  for (const match of matches) {
    const key = match.slice(1);
    if (variables[key] === undefined)
      return key;
  }
  return null;
}
function compatGuard(spec, trust) {
  const execution = spec.specialist.execution;
  if (execution.interactive)
    throw new CompatGuardError("execution.interactive", "interactive specialists are not allowed");
  if (execution.requires_worktree)
    throw new CompatGuardError("execution.requires_worktree", "worktree specialists are not allowed");
  if (execution.permission_required !== "READ_ONLY" && !trust?.allowWriteCapable) {
    throw new CompatGuardError("execution.permission_required", "permission_required must be READ_ONLY unless trusted local script mode is enabled");
  }
  const hasScripts = (spec.specialist.skills?.scripts?.length ?? 0) > 0;
  if (hasScripts && !trust?.allowLocalScripts) {
    throw new CompatGuardError("skills.scripts", "local scripts are not supported in this script surface");
  }
  const hasPaths = (spec.specialist.skills?.paths?.length ?? 0) > 0;
  const hasSkillInherit = Boolean(spec.specialist.prompt.skill_inherit);
  if (hasPaths && !trust?.allowSkills) {
    throw new CompatGuardError("skills.paths", "skills not allowed (enable with --allow-skills)");
  }
  if (hasSkillInherit && !trust?.allowSkills) {
    throw new CompatGuardError("prompt.skill_inherit", "skills not allowed (enable with --allow-skills)");
  }
  if (trust?.allowSkills) {
    const canonicalRoots = (trust.allowSkillsRoots ?? []).map((root) => canonicalizeSkillRoot(root, trust.baseDir));
    const paths = spec.specialist.skills?.paths ?? [];
    const canonicalPaths = paths.map((path) => canonicalRoots.length > 0 ? assertSkillPathWithinRoots("skills.paths", path, canonicalRoots, trust.baseDir) : canonicalizeSkillPath("skills.paths", path, trust.baseDir));
    if (spec.specialist.skills?.paths)
      spec.specialist.skills.paths = canonicalPaths;
    if (typeof spec.specialist.prompt.skill_inherit === "string") {
      spec.specialist.prompt.skill_inherit = canonicalRoots.length > 0 ? assertSkillPathWithinRoots("prompt.skill_inherit", spec.specialist.prompt.skill_inherit, canonicalRoots, trust.baseDir) : canonicalizeSkillPath("prompt.skill_inherit", spec.specialist.prompt.skill_inherit, trust.baseDir);
    }
  }
}
function collectSkillPathEntries(spec, baseDir) {
  return [
    ...(spec.specialist.skills?.paths ?? []).map((path) => ({ path: normalizePath(path, baseDir), source: "skills.paths" })),
    ...typeof spec.specialist.prompt.skill_inherit === "string" ? [{ path: normalizePath(spec.specialist.prompt.skill_inherit, baseDir), source: "prompt.skill_inherit" }] : []
  ];
}
function collectSkillPaths(spec, baseDir) {
  return collectSkillPathEntries(spec, baseDir).map((entry) => entry.path);
}
function requireNoFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new CompatGuardError("skills.paths", "secure no-follow skill source opening is unavailable; rejected");
  }
  return constants.O_NOFOLLOW;
}
function readSkillSourceBytes(path, noFollowFlag) {
  if (realpathSync(path) !== path)
    throw new Error("skill source canonical path changed");
  const declaredStat = lstatSync2(path);
  if (declaredStat.isSymbolicLink())
    throw new Error("symlinked skill source");
  const sourcePath = declaredStat.isDirectory() ? join7(path, "SKILL.md") : path;
  if (realpathSync(sourcePath) !== sourcePath)
    throw new Error("skill file canonical path changed");
  const sourceStat = lstatSync2(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile())
    throw new Error("skill source is not a regular file");
  accessSync(sourcePath, constants.R_OK);
  const fd = openSync(sourcePath, constants.O_RDONLY | noFollowFlag);
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("skill source is not a regular file");
    return readFileSync6(fd);
  } finally {
    closeSync(fd);
  }
}
function computeSkillSources(spec, baseDir) {
  const entries = collectSkillPathEntries(spec, baseDir);
  const noFollowFlag = entries.length > 0 ? requireNoFollowFlag() : 0;
  const sources = [];
  for (const { path, source } of entries) {
    try {
      const content = readSkillSourceBytes(path, noFollowFlag);
      const sha256 = createHash4("sha256").update(content).digest("hex");
      sources.push({ path, sha256, source, attestation: "observation_time_only" });
    } catch {
      sources.push({ path, sha256: "unreadable", source, attestation: "observation_time_only" });
    }
  }
  return sources;
}
function renderTaskTemplate(template, variables) {
  const missing = hasUnsubstitutedVariables(template, variables);
  if (missing)
    throw new Error(`Missing template variable: ${missing}`);
  return renderTemplate(template, variables);
}
function truncateForPrompt(value, limitBytes) {
  if (Buffer.byteLength(value, "utf8") <= limitBytes)
    return value;
  return `${value.slice(0, limitBytes)}
... truncated ...`;
}
function buildJsonOutputContract(spec) {
  if (spec.specialist.execution.response_format !== "json")
    return;
  const schema = spec.specialist.prompt.output_schema;
  const required = Array.isArray(schema?.required) ? schema.required.filter((value) => typeof value === "string") : [];
  const lines = [
    "Output contract:",
    "- Return only valid JSON. Do not include Markdown fences, prose, or commentary."
  ];
  if (required.length > 0)
    lines.push(`- Include these required top-level keys: ${required.join(", ")}.`);
  if (schema)
    lines.push(`- JSON schema: ${truncateForPrompt(JSON.stringify(schema), 4096)}`);
  return lines.join(`
`);
}
function applyOutputContract(prompt, spec) {
  const contract = buildJsonOutputContract(spec);
  return contract ? `${prompt}

${contract}` : prompt;
}
function mapErrorType(message) {
  const normalizedMessage = message.toLowerCase();
  if (message.includes("Specialist not found"))
    return "specialist_not_found";
  if (normalizedMessage.includes("interactive") || normalizedMessage.includes("worktree") || normalizedMessage.includes("permission_required") || normalizedMessage.includes("scripts not allowed"))
    return "specialist_load_error";
  if (message.includes("Missing template variable"))
    return "template_variable_missing";
  if (normalizedMessage.includes("prompt too large"))
    return "prompt_too_large";
  if (normalizedMessage.includes("output too large"))
    return "output_too_large";
  if (isAuthFailureMessage(normalizedMessage))
    return "auth";
  if (normalizedMessage.includes("quota") || normalizedMessage.includes("rate limit") || normalizedMessage.includes("out of extra usage") || normalizedMessage.includes("insufficient_quota") || normalizedMessage.includes("429"))
    return "quota";
  if (normalizedMessage.includes("timeout"))
    return "timeout";
  if (normalizedMessage.includes("network") || message.includes("ECONN"))
    return "network";
  if (message.includes("invalid JSON") || message.includes("Unexpected token"))
    return "invalid_json";
  return "internal";
}
function textFromMessage(message) {
  if (!message || message.role !== "assistant")
    return "";
  if (!Array.isArray(message.content))
    return "";
  return message.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}
function extractAssistantTextFromEvent(event) {
  if (event.type === "message_end") {
    const text = textFromMessage(event.message);
    if (text)
      return text;
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    for (let j = event.messages.length - 1;j >= 0; j--) {
      const text = textFromMessage(event.messages[j]);
      if (text)
        return text;
    }
  }
  if (event.type === "assistant" && typeof event.data?.text === "string")
    return event.data.text;
  const legacyContent = event.data?.content?.[0]?.text;
  if (typeof legacyContent === "string")
    return legacyContent;
  return;
}
function extractJsonPayload(text) {
  const trimmed = text.trim();
  const wholeFenced = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (wholeFenced)
    return wholeFenced[1].trim();
  const fencedBlocks = [...trimmed.matchAll(/```(?:json|JSON)\s*\n([\s\S]*?)\n```/g)];
  if (fencedBlocks.length === 1)
    return fencedBlocks[0][1].trim();
  return trimmed;
}
function appendScriptEvent(client, options) {
  if (!client || !options.event)
    return;
  try {
    client.appendEvent(options.traceId, options.specialist, undefined, options.event);
  } catch (error) {
    options.onAuditFailure?.(error);
  }
}
function createScriptTimelineAppender(client, options) {
  if (!client)
    return;
  return (event) => appendScriptEvent(client, { ...options, event });
}
function deriveBackendFromModel(model) {
  return model.includes("/") ? model.split("/")[0] : undefined;
}
function buildScriptStatus(options) {
  const backend = deriveBackendFromModel(options.model);
  return {
    id: options.traceId,
    specialist: options.specialist,
    status: options.status,
    model: options.model,
    ...backend ? { backend } : {},
    ...options.outputType ? { output_type: options.outputType } : {},
    started_at_ms: options.startedAtMs,
    elapsed_s: Math.max(0, (Date.now() - options.startedAtMs) / 1000),
    last_event_at_ms: Date.now(),
    trace_id: options.traceId,
    ...options.error ? { error: options.error } : {},
    startup_context: {
      job_id: options.traceId,
      specialist_name: options.specialist,
      variables_keys: options.variablesKeys ?? [],
      ...options.skillPaths ? { skills: { count: options.skillPaths.length, activated: options.skillPaths } } : {}
    },
    surface: "script_specialist",
    ...options.skillSources && options.skillSources.length > 0 ? { skill_sources: options.skillSources } : {},
    ...options.errorType ? { error_type: options.errorType } : {},
    ...options.parsedJson !== undefined ? { parsed_json: options.parsedJson } : {},
    ...options.outputSizeBytes !== undefined ? { output_size_bytes: options.outputSizeBytes } : {}
  };
}
function persistScriptStart(client, options) {
  if (!client)
    return;
  try {
    const status = buildScriptStatus({
      traceId: options.traceId,
      specialist: options.specialist,
      model: options.model,
      startedAtMs: options.startedAtMs,
      status: "running",
      outputType: options.outputType,
      skillSources: options.skillSources,
      variablesKeys: options.variablesKeys,
      skillPaths: options.skillPaths
    });
    client.upsertStatusWithEvent(status, createRunStartEvent(options.specialist, undefined, status.startup_context));
    const backend = deriveBackendFromModel(options.model);
    if (backend)
      client.appendEvent(options.traceId, options.specialist, undefined, createMetaEvent(options.model, backend));
  } catch (error) {
    options.onAuditFailure?.(error);
  }
}
function persistScriptTerminal(client, options) {
  if (!client)
    return;
  try {
    const status = buildScriptStatus({
      traceId: options.traceId,
      specialist: options.specialist,
      model: options.model,
      startedAtMs: options.startedAtMs,
      status: options.finalStatus,
      outputType: options.outputType,
      error: options.error,
      errorType: options.errorType,
      parsedJson: options.parsedJson,
      outputSizeBytes: Buffer.byteLength(options.output, "utf8"),
      skillSources: options.skillSources,
      variablesKeys: options.variablesKeys,
      skillPaths: options.skillPaths
    });
    const backend = deriveBackendFromModel(options.model);
    const runComplete = createRunCompleteEvent(options.finalStatus === "done" ? "COMPLETE" : "ERROR", Math.max(0, Math.round((Date.now() - options.startedAtMs) / 1000)), {
      model: options.model,
      ...backend ? { backend } : {},
      ...options.error ? { error: options.error } : {},
      output: options.output
    });
    client.upsertStatusWithEventAndResult(status, runComplete, options.output);
  } catch (error) {
    options.onAuditFailure?.(error);
  }
}
var DEFAULT_PENDING_LINE_LIMIT_BYTES = 16 * 1024 * 1024;
var DEFAULT_ASSISTANT_TEXT_LIMIT_BYTES = 4 * 1024 * 1024;
var DEFAULT_STDERR_LIMIT_BYTES = 1 * 1024 * 1024;
var DEFAULT_PROMPT_LIMIT_BYTES = 4 * 1024 * 1024;
function resolvePromptLimitBytes(spec) {
  return spec.specialist.execution.prompt_limit_bytes ?? resolveEnvPromptLimitBytes() ?? DEFAULT_PROMPT_LIMIT_BYTES;
}
function resolveEnvPromptLimitBytes() {
  const raw = process.env.SPECIALISTS_SCRIPT_PROMPT_LIMIT_BYTES;
  if (raw === undefined)
    return;
  const envLimit = Number(raw);
  if (!Number.isFinite(envLimit) || envLimit <= 0)
    return;
  return Math.floor(envLimit);
}
function resolveAssistantTextLimitBytes(spec) {
  return spec.specialist.execution.stdout_limit_bytes ?? resolveEnvAssistantTextLimitBytes() ?? DEFAULT_ASSISTANT_TEXT_LIMIT_BYTES;
}
function resolveEnvAssistantTextLimitBytes() {
  const raw = process.env.SPECIALISTS_SCRIPT_STDOUT_LIMIT_BYTES;
  if (raw === undefined)
    return;
  const envLimit = Number(raw);
  if (!Number.isFinite(envLimit) || envLimit <= 0)
    return;
  process.stderr.write(`warning: SPECIALISTS_SCRIPT_STDOUT_LIMIT_BYTES is deprecated; applies to assistant text cap
`);
  return Math.floor(envLimit);
}
function openObservabilityClient(options) {
  if (options.observabilityDbPath)
    return createObservabilitySqliteClientAtPath(options.observabilityDbPath);
  const projectDir = options.projectDir ?? process.cwd();
  try {
    const location = resolveObservabilityDbLocation(projectDir);
    ensureObservabilityDbFile(location);
    return createObservabilitySqliteClientAtPath(location.dbPath);
  } catch {
    return null;
  }
}
function resolveScriptSpecialistName(name) {
  if (name === "changelog-keeper")
    return "changelog-drafter";
  return name;
}
var TEMPLATE_FIELD_MISUSE_MAX_LEN = 30;
var TEMPLATE_FIELD_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function collectRequiredOutputKeys(spec) {
  const keys = new Set;
  const declared = spec.specialist.execution.expected_output_keys;
  if (Array.isArray(declared)) {
    for (const value of declared) {
      if (typeof value === "string" && value.length > 0)
        keys.add(value);
    }
  }
  if (spec.specialist.execution.response_format === "json") {
    const required = spec.specialist.prompt.output_schema?.required;
    if (Array.isArray(required)) {
      for (const value of required) {
        if (typeof value === "string" && value.length > 0)
          keys.add(value);
      }
    }
  }
  return Array.from(keys);
}
function outputSatisfiesJsonContract(text, requiredKeys) {
  try {
    const parsed = JSON.parse(extractJsonPayload(text));
    return requiredKeys.every((key) => parsed !== null && typeof parsed === "object" && (key in parsed));
  } catch {
    return false;
  }
}
function containsToolCallMarkup(text) {
  return /<\|tool_calls_section_(?:begin|end)\|>|<\|tool_call_(?:begin|argument_begin|end)\|>/.test(text);
}
function preferAssistantText(options) {
  const rpcText = options.rpcText.trim();
  const streamedText = options.streamedText.trim();
  if (!streamedText)
    return rpcText;
  if (!rpcText)
    return streamedText;
  const rpcHasMarkup = containsToolCallMarkup(rpcText);
  const streamedHasMarkup = containsToolCallMarkup(streamedText);
  if (rpcHasMarkup && !streamedHasMarkup)
    return streamedText;
  if (options.requiredJsonKeys.length > 0) {
    const rpcValid = outputSatisfiesJsonContract(rpcText, options.requiredJsonKeys);
    const streamedValid = outputSatisfiesJsonContract(streamedText, options.requiredJsonKeys);
    if (!rpcValid && streamedValid)
      return streamedText;
  }
  return rpcText;
}
function detectTemplateFieldMisuse(template, specPrompt) {
  if (!specPrompt)
    return null;
  if (template.length > TEMPLATE_FIELD_MISUSE_MAX_LEN)
    return null;
  if (!TEMPLATE_FIELD_IDENTIFIER_RE.test(template))
    return null;
  if (!Object.prototype.hasOwnProperty.call(specPrompt, template))
    return null;
  return template;
}
function getLocalScripts(spec) {
  return spec.specialist.skills?.scripts ?? [];
}
function getLocalScriptCommand(script) {
  return script.run || script.path;
}
function buildValidationSpec(spec, scripts) {
  return {
    specialist: {
      skills: {
        paths: spec.specialist.skills?.paths,
        scripts
      },
      capabilities: spec.specialist.capabilities
    }
  };
}
function resolveRequestedTemplate(input, spec) {
  if (input.template !== undefined && input.template_field !== undefined) {
    throw new Error("template and template_field are mutually exclusive");
  }
  if (input.template_field !== undefined) {
    const candidate = spec.specialist.prompt[input.template_field];
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error(`template field not found or not a string: spec.prompt.${input.template_field}`);
    }
    return candidate;
  }
  const template = input.template ?? spec.specialist.prompt.task_template;
  if (input.template !== undefined) {
    const misusedField = detectTemplateFieldMisuse(input.template, spec.specialist.prompt);
    if (misusedField !== null) {
      throw new Error(`template field misuse: input.template equals spec.prompt.${misusedField} key name (${input.template.length} chars). ` + `The 'template' input field expects the literal template body, not a spec key. ` + `To use a named template field, pass template_field=${misusedField}; ` + `to use the spec's default, omit both fields; to use a non-default template body, pass its full text inline.`);
    }
  }
  return template;
}
async function runScriptSpecialist(input, options) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  try {
    const resolvedSpecialist = resolveScriptSpecialistName(input.specialist);
    const spec = await options.loader.get(resolvedSpecialist);
    const baseDir = options.projectDir ?? options.trust?.baseDir ?? process.cwd();
    const trust = { ...options.trust, baseDir };
    compatGuard(spec, trust);
    const skillPaths = trust.allowSkills ? collectSkillPaths(spec, baseDir) : [];
    const permissionLevel = spec.specialist.execution.permission_required;
    const specialistName = spec.specialist.metadata?.name ?? resolvedSpecialist;
    const specialistPermissions = spec.specialist.permissions;
    const extensionSelection = resolveExecutionExtensionSelection(spec.specialist.execution.extensions);
    const resolvedToolContract = resolveRuntimeToolContract({
      level: permissionLevel,
      specialistName,
      specialistPermissions,
      excludeExtensions: extensionSelection.excludeExtensions,
      extensionSources: extensionSelection.extensionSources,
      cwd: baseDir
    });
    if (!resolvedToolContract) {
      throw new RuntimeToolCatalogResolutionError("canonical_catalog_unavailable");
    }
    const resolvedToolContractBlock = resolvedToolContract ? formatResolvedToolContract(resolvedToolContract) : "";
    const localScripts = getLocalScripts(spec);
    validateBeforeRun(buildValidationSpec(spec, localScripts), permissionLevel, resolvedToolContract);
    const executableScripts = trust.allowLocalScripts ? localScripts : [];
    const preScripts = executableScripts.filter((script) => script.phase === "pre");
    const postScripts = executableScripts.filter((script) => script.phase === "post");
    const preScriptResults = preScripts.map((script) => runScript(getLocalScriptCommand(script), baseDir));
    const requiredPreFailure = findRequiredPreScriptFailure(preScripts, preScriptResults);
    if (requiredPreFailure) {
      const modelCandidates2 = collectModelCandidates(input, spec, options);
      return {
        success: false,
        error: formatRequiredPreScriptFailure(requiredPreFailure),
        error_type: "pre_script_failed",
        meta: {
          specialist: resolvedSpecialist,
          requested_specialist: input.requested_specialist ?? input.specialist,
          resolved_specialist: resolvedSpecialist,
          model: modelCandidates2[0],
          duration_ms: Date.now() - startedAt,
          trace_id: traceId
        }
      };
    }
    const runPostScripts = () => {
      for (const script of postScripts)
        runScript(getLocalScriptCommand(script), baseDir);
    };
    const preScriptOutput = formatScriptOutput(preScriptResults.filter((_, index) => preScripts[index].inject_output));
    let template;
    try {
      template = resolveRequestedTemplate(input, spec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const modelCandidates2 = collectModelCandidates(input, spec, options);
      return {
        success: false,
        error: message,
        error_type: message.startsWith("template field misuse:") ? "template_field_misuse" : "specialist_load_error",
        meta: {
          specialist: resolvedSpecialist,
          requested_specialist: input.requested_specialist ?? input.specialist,
          resolved_specialist: resolvedSpecialist,
          model: modelCandidates2[0],
          duration_ms: Date.now() - startedAt,
          trace_id: traceId
        }
      };
    }
    const variables = {
      cwd: baseDir,
      bead_id: "",
      pre_script_output: preScriptOutput,
      ...input.variables ?? {},
      ...resolvedToolContractBlock ? { resolved_tool_contract: resolvedToolContractBlock } : {}
    };
    let prompt = applyOutputContract(renderTaskTemplate(template, variables), spec);
    try {
      const mandatoryRulesBlock = spec.specialist.execution.bare ? buildRequiredPlatformRulesBlock(baseDir) : buildMandatoryRulesInjection({ cwd: baseDir, specialist: spec.specialist }).block;
      if (mandatoryRulesBlock.trim())
        prompt = `${prompt}

${mandatoryRulesBlock}`;
    } catch (error) {
      console.warn(`[script-runner] Skipping MANDATORY_RULES injection: ${String(error)}`);
    }
    const modelCandidates = collectModelCandidates(input, spec, options);
    const promptLimitBytes = resolvePromptLimitBytes(spec);
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > promptLimitBytes) {
      return {
        success: false,
        error: `prompt too large: ${promptBytes} bytes exceeds limit ${promptLimitBytes} bytes`,
        error_type: "prompt_too_large",
        meta: {
          specialist: resolvedSpecialist,
          requested_specialist: input.requested_specialist ?? input.specialist,
          resolved_specialist: resolvedSpecialist,
          model: modelCandidates[0],
          duration_ms: Date.now() - startedAt,
          trace_id: traceId
        }
      };
    }
    if (process.env.SPECIALISTS_SCRIPT_STUB_OUTPUT) {
      return {
        success: true,
        output: prompt,
        meta: {
          specialist: resolvedSpecialist,
          requested_specialist: input.requested_specialist ?? input.specialist,
          resolved_specialist: resolvedSpecialist,
          model: "stub",
          duration_ms: Date.now() - startedAt,
          trace_id: traceId
        }
      };
    }
    const timeoutMs = input.timeout_ms ?? spec.specialist.execution.timeout_ms ?? 120000;
    const assistantTextLimitBytes = resolveAssistantTextLimitBytes(spec);
    const expectedKeys = collectRequiredOutputKeys(spec);
    const shouldParseJson = spec.specialist.execution.response_format === "json" || expectedKeys.length > 0;
    const skillSources = trust.allowSkills ? computeSkillSources(spec, baseDir) : undefined;
    const unreadableSkillSource = skillSources?.find((source) => source.sha256 === "unreadable");
    if (unreadableSkillSource) {
      throw new CompatGuardError(unreadableSkillSource.source, "skill source is unreadable after trusted pre-scripts; rejected");
    }
    const observability = input.trace !== false ? openObservabilityClient(options) : null;
    const scriptRunStartedAt = Date.now();
    if (observability) {
      persistScriptStart(observability, {
        traceId,
        specialist: resolvedSpecialist,
        model: modelCandidates[0] ?? "unknown",
        startedAtMs: scriptRunStartedAt,
        outputType: spec.specialist.execution.output_type,
        skillSources,
        variablesKeys: Object.keys(input.variables ?? {}),
        skillPaths,
        onAuditFailure: options.onAuditFailure
      });
    }
    const appendTimelineEvent = createScriptTimelineAppender(observability, {
      traceId,
      specialist: resolvedSpecialist,
      onAuditFailure: options.onAuditFailure
    });
    let terminalPersisted = false;
    let cleanupExitHandler;
    const persistTerminalOnce = (terminal) => {
      if (terminalPersisted)
        return;
      terminalPersisted = true;
      cleanupExitHandler?.();
      persistScriptTerminal(observability, terminal);
    };
    if (observability) {
      const handleExit = () => {
        if (terminalPersisted)
          return;
        terminalPersisted = true;
        persistScriptTerminal(observability, {
          traceId,
          specialist: resolvedSpecialist,
          model: modelCandidates[0] ?? "unknown",
          startedAtMs: scriptRunStartedAt,
          finalStatus: "error",
          outputType: spec.specialist.execution.output_type,
          output: "script-specialist interrupted before terminal result",
          error: "script-specialist interrupted before terminal result",
          errorType: "internal",
          skillSources,
          variablesKeys: Object.keys(input.variables ?? {}),
          skillPaths,
          onAuditFailure: options.onAuditFailure
        });
      };
      process.once("exit", handleExit);
      cleanupExitHandler = () => process.off("exit", handleExit);
    }
    const attempts = [];
    for (const model of modelCandidates) {
      const systemPrompt = spec.specialist.prompt.system || undefined;
      const systemPromptMode = spec.specialist.prompt.system_prompt_mode;
      let attempt;
      try {
        attempt = await runSingleAttempt(prompt, model, input.thinking_level ?? spec.specialist.execution.thinking_level, timeoutMs, assistantTextLimitBytes, options, spec, systemPrompt, systemPromptMode, skillPaths, shouldParseJson ? expectedKeys : [], resolvedToolContract, appendTimelineEvent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistTerminalOnce({
          traceId,
          specialist: resolvedSpecialist,
          model,
          startedAtMs: scriptRunStartedAt,
          finalStatus: "error",
          outputType: spec.specialist.execution.output_type,
          output: message,
          error: message,
          errorType: mapErrorType(message),
          skillSources,
          variablesKeys: Object.keys(input.variables ?? {}),
          skillPaths,
          onAuditFailure: options.onAuditFailure
        });
        throw error;
      }
      attempts.push(attempt);
      const parsed = classifyAttempt(attempt);
      if (parsed.retryable && parsed.errorType !== "auth")
        continue;
      const durationMs2 = Date.now() - startedAt;
      if (parsed.kind === "success") {
        let parsed_json;
        if (shouldParseJson) {
          try {
            parsed_json = JSON.parse(extractJsonPayload(parsed.text));
            for (const key of expectedKeys) {
              if (parsed_json === null || typeof parsed_json !== "object" || !(key in parsed_json))
                throw new Error(`Missing required output field: ${key}`);
            }
          } catch (error) {
            if (observability) {
              persistTerminalOnce({
                traceId,
                specialist: resolvedSpecialist,
                model,
                startedAtMs: scriptRunStartedAt,
                finalStatus: "error",
                outputType: spec.specialist.execution.output_type,
                output: parsed.text || (error instanceof Error ? error.message : String(error)),
                error: error instanceof Error ? error.message : String(error),
                errorType: "invalid_json",
                skillSources,
                variablesKeys: Object.keys(input.variables ?? {}),
                skillPaths,
                onAuditFailure: options.onAuditFailure
              });
            }
            runPostScripts();
            return { success: false, error: error instanceof Error ? error.message : String(error), error_type: "invalid_json", meta: { specialist: resolvedSpecialist, requested_specialist: input.requested_specialist ?? input.specialist, resolved_specialist: resolvedSpecialist, model, duration_ms: durationMs2, trace_id: traceId } };
          }
        }
        if (observability) {
          persistTerminalOnce({
            traceId,
            specialist: resolvedSpecialist,
            model,
            startedAtMs: scriptRunStartedAt,
            finalStatus: "done",
            outputType: spec.specialist.execution.output_type,
            output: parsed.text,
            parsedJson: parsed_json,
            skillSources,
            variablesKeys: Object.keys(input.variables ?? {}),
            skillPaths,
            onAuditFailure: options.onAuditFailure
          });
        }
        runPostScripts();
        return { success: true, output: parsed.text, parsed_json, meta: { specialist: resolvedSpecialist, requested_specialist: input.requested_specialist ?? input.specialist, resolved_specialist: resolvedSpecialist, model, duration_ms: durationMs2, trace_id: traceId } };
      }
      if (observability) {
        persistTerminalOnce({
          traceId,
          specialist: resolvedSpecialist,
          model,
          startedAtMs: scriptRunStartedAt,
          finalStatus: "error",
          outputType: spec.specialist.execution.output_type,
          output: parsed.text || parsed.error,
          error: parsed.error,
          errorType: parsed.errorType,
          skillSources,
          variablesKeys: Object.keys(input.variables ?? {}),
          skillPaths,
          onAuditFailure: options.onAuditFailure
        });
      }
      runPostScripts();
      return { success: false, error: parsed.error, error_type: parsed.errorType, meta: { specialist: resolvedSpecialist, requested_specialist: input.requested_specialist ?? input.specialist, resolved_specialist: resolvedSpecialist, model, duration_ms: durationMs2, trace_id: traceId } };
    }
    const lastAttempt = attempts.at(-1);
    const durationMs = Date.now() - startedAt;
    if (observability) {
      persistTerminalOnce({
        traceId,
        specialist: resolvedSpecialist,
        model: modelCandidates.at(-1) ?? "unknown",
        startedAtMs: scriptRunStartedAt,
        finalStatus: "error",
        outputType: spec.specialist.execution.output_type,
        output: lastAttempt?.text || lastAttempt?.stderr || "pi produced no assistant text",
        error: lastAttempt?.stderr || "pi produced no assistant text",
        errorType: "internal",
        skillSources,
        variablesKeys: Object.keys(input.variables ?? {}),
        skillPaths,
        onAuditFailure: options.onAuditFailure
      });
    }
    runPostScripts();
    return { success: false, error: lastAttempt?.stderr || "pi produced no assistant text", error_type: "internal", meta: { specialist: resolvedSpecialist, requested_specialist: input.requested_specialist ?? input.specialist, resolved_specialist: resolvedSpecialist, model: modelCandidates.at(-1) ?? "unknown", duration_ms: durationMs, trace_id: traceId } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const resolvedSpecialist = resolveScriptSpecialistName(input.specialist);
    return { success: false, error: message, error_type: error instanceof RuntimeToolCatalogResolutionError ? "runtime_tool_catalog_unavailable" : mapErrorType(message), meta: { specialist: resolvedSpecialist, requested_specialist: input.requested_specialist ?? input.specialist, resolved_specialist: resolvedSpecialist, duration_ms: Date.now() - startedAt, trace_id: traceId } };
  }
}
function collectModelCandidates(input, spec, options) {
  const executionChain = resolveModelChain(spec.specialist.execution);
  const candidates = [input.model_override, ...executionChain, options.fallbackModel].filter((value) => typeof value === "string" && value.length > 0);
  return [...new Set(candidates)];
}
function appendExtensionArgs(args, spec, resolvedToolContract, extensionSources = []) {
  const permissionLevel = spec.specialist.execution.permission_required.toUpperCase();
  const readLineNumbersPath = getReadLineNumbersExtensionPath();
  if (readLineNumbersPath)
    args.push("-e", readLineNumbersPath);
  const piExtDir = join7(homedir4(), ".pi", "agent", "extensions");
  if (permissionLevel !== "READ_ONLY") {
    const qualityGatesPath = join7(piExtDir, "quality-gates");
    if (existsSync11(qualityGatesPath))
      args.push("-e", qualityGatesPath);
  }
  const cavemanPath = join7(piExtDir, "caveman");
  if (existsSync11(cavemanPath))
    args.push("-e", cavemanPath);
  const gitnexusContract = resolvedToolContract?.extensions.gitnexus;
  if (gitnexusContract?.status === "available" && gitnexusContract.packagePath && existsSync11(gitnexusContract.packagePath)) {
    args.push("-e", gitnexusContract.packagePath);
  }
  for (const source of extensionSources) {
    args.push("-e", source);
  }
}
async function runSingleAttempt(prompt, model, thinkingLevel, timeoutMs, assistantTextLimitBytes, options, spec, systemPrompt, systemPromptMode, skillPaths = [], requiredJsonKeys = [], resolvedToolContract, appendTimelineEvent) {
  const extensionSelection = resolveExecutionExtensionSelection(spec.specialist.execution.extensions);
  if (options.surface === "script" && spec.specialist.execution.permission_required !== "READ_ONLY") {
    const session = await PiAgentSession.create({
      model,
      systemPrompt,
      systemPromptMode,
      permissionLevel: spec.specialist.execution.permission_required,
      specialistName: spec.specialist.metadata?.name,
      specialistPermissions: spec.specialist.permissions,
      skillPaths,
      thinkingLevel,
      cwd: options.projectDir ?? process.cwd(),
      stallTimeoutMs: spec.specialist.execution.stall_timeout_ms ?? timeoutMs,
      ...extensionSelection.excludeExtensions.length > 0 ? { excludeExtensions: extensionSelection.excludeExtensions } : {},
      ...extensionSelection.extensionSources.length > 0 ? { extensionSources: extensionSelection.extensionSources } : {},
      ...extensionSelection.offline === false ? { offline: false } : {},
      resolvedToolContract,
      onToken: (delta) => {
        recordAssistantDelta(delta);
        appendTimelineEvent?.({ t: Date.now(), type: "text", char_count: delta.length });
      },
      onThinking: (delta) => appendTimelineEvent?.({ t: Date.now(), type: "thinking", char_count: delta.length }),
      onToolStart: (tool, args, toolCallId) => appendTimelineEvent?.(mapCallbackEventToTimelineEvent("tool_execution_start", { tool, args, toolCallId })),
      onToolEnd: (tool, isError, toolCallId, resultContent, resultRaw) => appendTimelineEvent?.(mapCallbackEventToTimelineEvent("tool_execution_end", { tool, isError, toolCallId, resultContent, resultRaw })),
      onEvent: (type, details) => {
        if (type === "message_start_assistant")
          markAssistantMessageStart();
        if (type === "message_end_assistant")
          markAssistantMessageEnd();
        appendTimelineEvent?.(mapCallbackEventToTimelineEvent(type, {
          charCount: details?.charCount,
          toolCallId: details?.toolCallId,
          compaction: details,
          retry: details,
          modelChange: details?.action ? { action: details.action, model: details.model, previousModel: details.previousModel } : undefined,
          extensionError: details
        }));
      },
      onMetric: (event) => {
        if (event.type === "token_usage")
          appendTimelineEvent?.(createTokenUsageEvent(event.token_usage, event.source));
        if (event.type === "finish_reason")
          appendTimelineEvent?.(createFinishReasonEvent(event.finish_reason, event.source));
        if (event.type === "turn_summary")
          appendTimelineEvent?.(createTurnSummaryEvent(event.turn_index, event.token_usage, event.finish_reason));
        if (event.type === "api_error")
          appendTimelineEvent?.(mapCallbackEventToTimelineEvent("api_error", { apiError: event }));
        if (event.type === "compaction")
          appendTimelineEvent?.(mapCallbackEventToTimelineEvent(event.phase === "start" ? "auto_compaction_start" : "auto_compaction_end", { compaction: event }));
        if (event.type === "retry")
          appendTimelineEvent?.(mapCallbackEventToTimelineEvent(event.phase === "start" ? "auto_retry_start" : "auto_retry_end", { retry: event }));
        if (event.type === "extension_error")
          appendTimelineEvent?.(mapCallbackEventToTimelineEvent("extension_error", { extensionError: event }));
      },
      onMeta: (meta) => appendTimelineEvent?.(createMetaEvent(meta.model, meta.backend))
    });
    let assistantText = "";
    let stderr = "";
    let timedOut = false;
    let outputTooLarge = false;
    let outputTooLargeReason;
    let currentAssistantMessage = "";
    let lastCompletedAssistantMessage = "";
    const markAssistantMessageStart = () => {
      currentAssistantMessage = "";
    };
    const markAssistantMessageEnd = () => {
      if (currentAssistantMessage.trim())
        lastCompletedAssistantMessage = currentAssistantMessage;
      currentAssistantMessage = "";
    };
    const recordAssistantDelta = (delta) => {
      if (!delta)
        return;
      currentAssistantMessage += delta;
    };
    const resolveAssistantText = async () => {
      const rpcText = await session.getLastOutput();
      return preferAssistantText({
        rpcText,
        streamedText: lastCompletedAssistantMessage,
        requiredJsonKeys
      });
    };
    try {
      await session.start();
      await session.prompt(prompt);
      await session.waitForDone(timeoutMs);
      assistantText = await resolveAssistantText();
      stderr = session.getStderr();
      if (requiredJsonKeys.length > 0 && !outputSatisfiesJsonContract(assistantText, requiredJsonKeys)) {
        const repairPrompt = [
          "Return FINAL answer now as JSON only.",
          `Required top-level keys: ${requiredJsonKeys.join(", ")}.`,
          "No prose. No markdown fences. No tool-call markup. No preamble or commentary.",
          "Use work already completed in this session. Do not restart from scratch. Avoid more tools unless strictly necessary."
        ].join(" ");
        markAssistantMessageStart();
        await session.resume(repairPrompt, timeoutMs);
        assistantText = await resolveAssistantText();
        stderr = session.getStderr();
      }
      if (Buffer.byteLength(assistantText, "utf8") > assistantTextLimitBytes) {
        outputTooLarge = true;
        outputTooLargeReason = "assistant_text_too_large";
      }
      return {
        model,
        text: assistantText,
        stderr,
        exitCode: 0,
        timedOut,
        outputTooLarge,
        outputTooLargeReason
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      timedOut = message.toLowerCase().includes("timed out");
      if (timedOut)
        session.kill(error instanceof Error ? error : new Error(message));
      assistantText = await session.getLastOutput().catch(() => "");
      stderr = session.getStderr() || message;
      return {
        model,
        text: assistantText,
        stderr,
        exitCode: 1,
        timedOut,
        outputTooLarge,
        outputTooLargeReason
      };
    } finally {
      await session.close().catch(() => {
        return;
      });
    }
  }
  return await new Promise((resolve10, reject) => {
    const args = ["--mode", "json", "--no-session", "--no-extensions", "--no-skills"];
    if (extensionSelection.offline !== false)
      args.push("--offline");
    args.push("--no-context-files", "--no-prompt-templates", "--no-themes");
    const toolsFlag = resolvedToolContract?.toolsFlag;
    if (toolsFlag && resolvedToolContract.exposedExtensionSources.length === 0)
      args.push("--tools", toolsFlag);
    for (const skillPath of skillPaths)
      args.push("--skill", skillPath);
    args.push("--model", model);
    if (thinkingLevel)
      args.push("--thinking", thinkingLevel);
    if (systemPrompt)
      args.push(systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", systemPrompt);
    appendExtensionArgs(args, spec, resolvedToolContract, extensionSelection.extensionSources);
    const policyEnv = {};
    applyExtensionToolPolicyGate(args, resolvedToolContract, policyEnv);
    const pi = spawn2("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.projectDir ?? process.cwd(),
      ...Object.keys(policyEnv).length > 0 ? { env: { ...process.env, ...policyEnv } } : {}
    });
    options.onChild?.(pi);
    pi.stdin?.on("error", () => {});
    pi.stdin?.write(prompt);
    pi.stdin?.end();
    let stderr = "";
    let timedOut = false;
    let outputTooLarge = false;
    let outputTooLargeReason;
    let pending = "";
    let assistantText = "";
    let pendingBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      pi.kill("SIGTERM");
      setTimeout(() => pi.kill("SIGKILL"), 2000);
    }, timeoutMs);
    pi.stdout.on("data", (chunk) => {
      if (outputTooLarge)
        return;
      const buffer = Buffer.from(chunk);
      pending += buffer.toString("utf-8");
      pendingBytes += buffer.length;
      if (pendingBytes > DEFAULT_PENDING_LINE_LIMIT_BYTES) {
        outputTooLarge = true;
        outputTooLargeReason = "malformed_line_too_large";
        pi.kill("SIGTERM");
        setTimeout(() => pi.kill("SIGKILL"), 2000);
        return;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      pendingBytes = Buffer.byteLength(pending);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line)
          continue;
        try {
          const event = JSON.parse(line);
          const nextAssistantText = extractAssistantTextFromEvent(event);
          if (nextAssistantText !== undefined) {
            if (Buffer.byteLength(nextAssistantText, "utf8") > assistantTextLimitBytes) {
              outputTooLarge = true;
              outputTooLargeReason = "assistant_text_too_large";
              pi.kill("SIGTERM");
              setTimeout(() => pi.kill("SIGKILL"), 2000);
              return;
            }
            assistantText = nextAssistantText;
          }
        } catch {
          continue;
        }
      }
    });
    pi.stderr.on("data", (chunk) => {
      if (outputTooLarge)
        return;
      const text = String(chunk);
      stderr += text;
      stderrBytes += Buffer.byteLength(text, "utf8");
      if (stderrBytes > DEFAULT_STDERR_LIMIT_BYTES) {
        outputTooLarge = true;
        outputTooLargeReason = "stderr_too_large";
        stderr = stderr.slice(0, DEFAULT_STDERR_LIMIT_BYTES);
        pi.kill("SIGTERM");
        setTimeout(() => pi.kill("SIGKILL"), 2000);
      }
    });
    pi.on("error", reject);
    pi.on("close", (code) => {
      clearTimeout(timer);
      resolve10({
        model,
        text: assistantText,
        stderr,
        exitCode: code ?? 0,
        timedOut,
        outputTooLarge,
        outputTooLargeReason
      });
    });
  });
}
function classifyAttempt(attempt) {
  if (attempt.outputTooLarge) {
    if (attempt.outputTooLargeReason === "assistant_text_too_large")
      return { retryable: false, kind: "failure", error: "assistant message too large", errorType: "output_too_large", text: attempt.text };
    if (attempt.outputTooLargeReason === "stderr_too_large")
      return { retryable: false, kind: "failure", error: "stderr too large", errorType: "output_too_large", text: attempt.text };
    if (attempt.outputTooLargeReason === "malformed_line_too_large")
      return { retryable: false, kind: "failure", error: "malformed line too large", errorType: "output_too_large", text: attempt.text };
    return { retryable: false, kind: "failure", error: "output exceeded cap", errorType: "output_too_large", text: attempt.text };
  }
  if (attempt.timedOut)
    return { retryable: false, kind: "failure", error: attempt.stderr || "timed out", errorType: "timeout", text: attempt.text };
  const errorType = mapErrorType(attempt.stderr);
  const retryable = errorType !== "auth" && isRetryableModelFailure(attempt.stderr, attempt.text);
  if (attempt.exitCode !== 0) {
    return { retryable, kind: "failure", error: attempt.stderr || `pi exit ${attempt.exitCode}`, errorType, text: attempt.text };
  }
  if (!attempt.text) {
    return { retryable, kind: "failure", error: attempt.stderr || "pi produced no assistant text", errorType, text: attempt.text };
  }
  return { retryable: false, kind: "success", error: "", errorType: "internal", text: attempt.text };
}
function isRetryableModelFailure(stderr, text) {
  const normalizedStderr = stderr.toLowerCase();
  if (isAuthFailureMessage(normalizedStderr))
    return false;
  return normalizedStderr.includes("0 tokens") || normalizedStderr.includes("quota") || normalizedStderr.includes("rate limit") || normalizedStderr.includes("insufficient_quota") || !text && !normalizedStderr.trim();
}
function isAuthFailureMessage(message) {
  return /\b(401|403)\b/.test(message) || message.includes("auth") || message.includes("unauthorized") || message.includes("forbidden") || message.includes("invalid_api_key") || message.includes("authentication failed") || message.includes("credentials");
}
// src/specialist/loader.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { basename as basename3, join as join11 } from "node:path";
import { existsSync as existsSync14 } from "node:fs";

// node_modules/yaml/dist/index.js
var composer = require_composer();
var Document = require_Document();
var Schema = require_Schema();
var errors = require_errors();
var Alias = require_Alias();
var identity = require_identity();
var Pair = require_Pair();
var Scalar = require_Scalar();
var YAMLMap = require_YAMLMap();
var YAMLSeq = require_YAMLSeq();
var cst = require_cst();
var lexer = require_lexer();
var lineCounter = require_line_counter();
var parser = require_parser();
var publicApi = require_public_api();
var visit = require_visit();
var $Composer = composer.Composer;
var $Document = Document.Document;
var $Schema = Schema.Schema;
var $YAMLError = errors.YAMLError;
var $YAMLParseError = errors.YAMLParseError;
var $YAMLWarning = errors.YAMLWarning;
var $Alias = Alias.Alias;
var $isAlias = identity.isAlias;
var $isCollection = identity.isCollection;
var $isDocument = identity.isDocument;
var $isMap = identity.isMap;
var $isNode = identity.isNode;
var $isPair = identity.isPair;
var $isScalar = identity.isScalar;
var $isSeq = identity.isSeq;
var $Pair = Pair.Pair;
var $Scalar = Scalar.Scalar;
var $YAMLMap = YAMLMap.YAMLMap;
var $YAMLSeq = YAMLSeq.YAMLSeq;
var $Lexer = lexer.Lexer;
var $LineCounter = lineCounter.LineCounter;
var $Parser = parser.Parser;
var $parse = publicApi.parse;
var $parseAllDocuments = publicApi.parseAllDocuments;
var $parseDocument = publicApi.parseDocument;
var $stringify = publicApi.stringify;
var $visit = visit.visit;
var $visitAsync = visit.visitAsync;

// src/specialist/schema.ts
var KebabCase = stringType().regex(/^[a-z][a-z0-9-]*$/, "Must be kebab-case");
var Semver = stringType().regex(/^\d+\.\d+\.\d+$/, "Must be semver (e.g. 1.0.0)");
var MetadataSchema = objectType({
  name: KebabCase,
  version: Semver,
  description: stringType(),
  category: stringType(),
  updated: stringType().optional(),
  tags: arrayType(stringType()).optional()
}).passthrough();
var ExtensionToggleSchema = booleanType();
var ExecutionSchema = objectType({
  mode: enumType(["tool", "skill", "auto"]).default("auto"),
  model: stringType().nullable(),
  surface_models: recordType(stringType()).optional(),
  fallback_model: stringType().nullable().optional(),
  fallback_models: arrayType(stringType()).nullable().optional(),
  timeout_ms: numberType().default(120000),
  stall_timeout_ms: numberType().optional(),
  max_retries: numberType().int().min(0).default(0),
  interactive: booleanType().default(false),
  stdout_limit_bytes: numberType().int().positive().optional(),
  prompt_limit_bytes: numberType().int().positive().optional(),
  response_format: enumType(["text", "json", "markdown"]).default("text"),
  output_type: enumType(["codegen", "analysis", "review", "synthesis", "orchestration", "workflow", "research", "custom"]).default("custom"),
  permission_required: enumType(["READ_ONLY", "LOW", "MEDIUM", "HIGH"]).default("READ_ONLY"),
  requires_worktree: booleanType().default(true),
  bare: booleanType().default(false),
  thinking_level: enumType(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  auto_commit: enumType(["never", "checkpoint_on_waiting", "checkpoint_on_terminal"]).default("never"),
  extensions: recordType(stringType(), ExtensionToggleSchema).optional(),
  expected_output_keys: arrayType(stringType()).optional()
}).passthrough();
var PromptSchema = objectType({
  system: stringType().optional(),
  system_prompt_mode: enumType(["append", "replace"]).optional(),
  task_template: stringType(),
  output_schema: recordType(unknownType()).optional(),
  skill_inherit: stringType().optional()
}).passthrough();
var ScriptEntrySchema = objectType({
  run: stringType(),
  phase: enumType(["pre", "post"]),
  inject_output: booleanType().default(false),
  required: booleanType().optional()
}).passthrough();
var SkillsSchema = objectType({
  paths: arrayType(stringType()).optional(),
  scripts: arrayType(ScriptEntrySchema).optional()
}).passthrough().optional();
var CapabilitiesSchema = objectType({
  required_tools: arrayType(stringType()).optional(),
  external_commands: arrayType(stringType()).optional()
}).passthrough().optional();
var ValidationSchema = objectType({
  files_to_watch: arrayType(stringType()).optional(),
  stale_threshold_days: numberType().optional()
}).passthrough().optional();
var MandatoryRuleSchema = objectType({
  id: stringType(),
  level: enumType(["error", "warn", "info"]).default("error"),
  text: stringType(),
  when: stringType().optional()
}).passthrough();
var MandatoryRulesSchema = objectType({
  template_sets: arrayType(KebabCase).default([]),
  disable_default_globals: booleanType().default(false),
  inline_rules: arrayType(MandatoryRuleSchema).default([])
}).passthrough().optional();
var SpecialistPermissionTierSchema = objectType({
  denied_natives_when_extension: arrayType(stringType()).optional(),
  denied_natives_mode: enumType(["soft", "hard"]).optional()
}).passthrough();
var SpecialistPermissionsSchema = objectType({
  READ_ONLY: SpecialistPermissionTierSchema.optional(),
  LOW: SpecialistPermissionTierSchema.optional(),
  MEDIUM: SpecialistPermissionTierSchema.optional(),
  HIGH: SpecialistPermissionTierSchema.optional()
}).partial();
var StallDetectionSchema = objectType({
  running_silence_warn_ms: numberType().optional(),
  running_silence_error_ms: numberType().optional(),
  waiting_stale_ms: numberType().optional(),
  waiting_auto_close_ms: numberType().nullable().optional(),
  tool_duration_warn_ms: numberType().optional()
}).passthrough().optional();
var SpecialistSchema = objectType({
  specialist: objectType({
    metadata: MetadataSchema,
    execution: ExecutionSchema,
    prompt: PromptSchema,
    skills: SkillsSchema,
    capabilities: CapabilitiesSchema,
    validation: ValidationSchema,
    stall_detection: StallDetectionSchema,
    mandatory_rules: MandatoryRulesSchema,
    permissions: SpecialistPermissionsSchema.optional(),
    output_file: stringType().optional(),
    notes_mode: enumType(["full-trail", "final-only"]).default("full-trail"),
    beads_integration: enumType(["auto", "always", "never"]).default("auto"),
    beads_write_notes: booleanType().default(true)
  }).passthrough()
}).passthrough();
var OVERRIDE_ALLOWED_EXECUTION_FIELDS = [
  "model",
  "fallback_model",
  "fallback_models",
  "timeout_ms",
  "stall_timeout_ms",
  "interactive",
  "thinking_level",
  "max_retries",
  "prompt_limit_bytes",
  "stdout_limit_bytes"
];
var OVERRIDE_ALLOWED_NESTED_EXECUTION_PATHS = ["extensions"];
var OVERRIDE_ALLOWED_STALL_DETECTION_PATHS = [
  "waiting_auto_close_ms"
];
var OVERRIDE_ALLOWED_PROMPT_FIELDS = ["system_prompt_mode"];
var OVERRIDE_ALLOWED_MANDATORY_RULES_FIELDS = ["template_sets"];
var OVERRIDE_ALLOWED_TOP_FIELDS = ["beads_write_notes", "notes_mode", "output_file"];
var BLOCKED_OVERRIDE_FIELDS = [
  "execution.permission_required",
  "execution.auto_commit",
  "prompt.system",
  "prompt.output_schema",
  "skills.scripts",
  "mandatory_rules.inline_rules",
  "mandatory_rules.disable_default_globals",
  "capabilities"
];
function formatPath(path) {
  return path.map((p) => typeof p === "number" ? `[${p}]` : p).join(".");
}
function getFriendlyMessage(issue) {
  const path = formatPath(issue.path);
  if (issue.code === "invalid_string" && issue.validation === "regex") {
    if (path.includes("name")) {
      return `Invalid specialist name: must be kebab-case (lowercase letters, numbers, hyphens). Got: "${issue.path.at(-1) === "name" ? "invalid value" : "see schema"}"`;
    }
    if (path.includes("version")) {
      return `Invalid version: must be semver format (e.g., "1.0.0"). Got value that doesn't match pattern.`;
    }
  }
  if (issue.code === "invalid_enum_value") {
    const allowed = issue.options.map((o) => `"${o}"`).join(", ");
    if (path.includes("permission_required")) {
      return `Invalid permission_required: must be one of ${allowed}. This controls which pi tools are available.`;
    }
    if (path.includes("mode")) {
      return `Invalid execution.mode: must be one of ${allowed}.`;
    }
    if (path.includes("beads_integration")) {
      return `Invalid beads_integration: must be one of ${allowed}.`;
    }
    return `Invalid value at "${path}": expected one of ${allowed}, got "${issue.received}"`;
  }
  if (issue.code === "invalid_type") {
    return `Invalid type at "${path}": expected ${issue.expected}, got ${issue.received}`;
  }
  if (issue.code === "invalid_literal") {
    return `Invalid value at "${path}": expected "${issue.expected}"`;
  }
  return issue.message;
}
async function validateSpecialist(jsonContent) {
  const errors2 = [];
  const warnings = [];
  let raw;
  try {
    raw = JSON.parse(jsonContent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors2.push({
      path: "json",
      message: `JSON parse error: ${msg}`,
      code: "json_parse_error"
    });
    return { valid: false, errors: errors2, warnings };
  }
  const result = SpecialistSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors2.push({
        path: formatPath(issue.path),
        message: getFriendlyMessage(issue),
        code: issue.code
      });
    }
  } else {
    const spec = result.data;
    const declaredModel = spec.specialist.execution.model;
    if (declaredModel && !declaredModel.includes("/")) {
      warnings.push(`Model "${declaredModel}" doesn't include a provider prefix. Expected format: "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5")`);
    }
  }
  return { valid: errors2.length === 0, errors: errors2, warnings };
}
async function parseSpecialist(jsonContent) {
  const result = await validateSpecialist(jsonContent);
  if (!result.valid) {
    const errorList = result.errors.map((e) => `  • ${e.message}`).join(`
`);
    throw new Error(`Schema validation failed:
${errorList}`);
  }
  if (result.warnings.length > 0) {
    process.stderr.write(`[specialists] warnings:
${result.warnings.map((w) => `  ⚠ ${w}`).join(`
`)}
`);
  }
  const raw = JSON.parse(jsonContent);
  return SpecialistSchema.parseAsync(raw);
}

// src/specialist/global-config.ts
import {
  existsSync as existsSync12,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync7,
  renameSync,
  rmSync,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname7, join as join8 } from "node:path";
import { homedir as homedir5 } from "node:os";
var CONFIG_FILENAME = "user.json";
var SPECIALISTS_SUBDIR = "specialists";
function getGlobalUserConfigPath() {
  const home = process.env.HOME?.trim() || homedir5();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    const xdgPath = join8(xdgConfigHome, SPECIALISTS_SUBDIR, CONFIG_FILENAME);
    return { path: xdgPath, exists: existsSync12(xdgPath), source: "xdg" };
  }
  const configHomePath = join8(home, ".config", SPECIALISTS_SUBDIR, CONFIG_FILENAME);
  if (existsSync12(configHomePath)) {
    return { path: configHomePath, exists: true, source: "config-home" };
  }
  const legacyPath = join8(home, ".specialists", CONFIG_FILENAME);
  if (existsSync12(legacyPath)) {
    return { path: legacyPath, exists: true, source: "legacy" };
  }
  return { path: configHomePath, exists: false, source: "config-home" };
}
var OverrideExtensionsSchema = recordType(stringType(), ExtensionToggleSchema.nullable());
var OverrideExecutionSchema = objectType({
  model: stringType().nullable(),
  fallback_model: stringType().nullable(),
  fallback_models: arrayType(stringType()).nullable().optional(),
  timeout_ms: numberType().nullable(),
  stall_timeout_ms: numberType().nullable(),
  interactive: booleanType().nullable().optional(),
  thinking_level: enumType(["off", "minimal", "low", "medium", "high", "xhigh"]).nullable(),
  max_retries: numberType().int().min(0).nullable(),
  prompt_limit_bytes: numberType().int().positive().nullable().optional(),
  stdout_limit_bytes: numberType().int().positive().nullable().optional(),
  extensions: OverrideExtensionsSchema.optional()
}).strict();
var OverridePromptSchema = objectType({
  system_prompt_mode: enumType(["append", "replace"]).nullable()
}).strict();
var OverrideStallDetectionSchema = objectType({
  waiting_auto_close_ms: numberType().nullable().optional()
}).strict();
var OverrideSkillsSchema = objectType({
  paths: arrayType(stringType())
}).strict();
var OverrideMandatoryRulesSchema = objectType({
  template_sets: arrayType(KebabCase).nullable()
}).strict();
var GlobalSpecialistOverrideSchema = objectType({
  execution: OverrideExecutionSchema,
  prompt: OverridePromptSchema.optional(),
  stall_detection: OverrideStallDetectionSchema.optional(),
  beads_write_notes: booleanType().nullable(),
  notes_mode: enumType(["full-trail", "final-only"]).nullable().optional(),
  output_file: stringType().nullable().optional(),
  skills: OverrideSkillsSchema,
  mandatory_rules: OverrideMandatoryRulesSchema.optional()
}).strict();
var GlobalUserConfigSchema = preprocessType((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")));
}, recordType(stringType(), GlobalSpecialistOverrideSchema));
function readGlobalUserConfig(location) {
  if (!location.exists)
    return null;
  const content = readFileSync7(location.path, "utf-8");
  return JSON.parse(content);
}

// src/specialist/preset-resolver.ts
import { existsSync as existsSync13, readFileSync as readFileSync8 } from "node:fs";
import { join as join9 } from "node:path";
var PRESET_REFERENCE_PREFIX = "@preset/";
var PRESET_REFERENCE_MAX_DEPTH = 4;
var presetsCache = null;
var presetsCacheBaseDir = null;

class SpecialistPresetNotFoundError extends Error {
  presetName;
  specialist;
  fieldPath;
  knownPresets;
  constructor(presetName, specialist, fieldPath, knownPresets) {
    super(`preset "${presetName}" referenced by ${formatReferenceLocation(specialist, fieldPath)} not found in config/presets.json. Known presets: ${knownPresets.join(", ") || "(none)"}`);
    this.presetName = presetName;
    this.specialist = specialist;
    this.fieldPath = fieldPath;
    this.knownPresets = knownPresets;
    this.name = "SpecialistPresetNotFoundError";
  }
}

class SpecialistPresetCycleError extends Error {
  visited;
  specialist;
  fieldPath;
  constructor(visited, specialist, fieldPath) {
    super(`preset cycle referenced by ${formatReferenceLocation(specialist, fieldPath)}: ${visited.join(" -> ")}`);
    this.visited = visited;
    this.specialist = specialist;
    this.fieldPath = fieldPath;
    this.name = "SpecialistPresetCycleError";
  }
}

class SpecialistPresetTypeError extends Error {
  presetName;
  specialist;
  fieldPath;
  expectedType;
  actualType;
  constructor(presetName, specialist, fieldPath, expectedType, actualType) {
    super(`preset "${presetName}" referenced by ${formatReferenceLocation(specialist, fieldPath)} resolved invalid value type: expected ${expectedType}, got ${actualType}`);
    this.presetName = presetName;
    this.specialist = specialist;
    this.fieldPath = fieldPath;
    this.expectedType = expectedType;
    this.actualType = actualType;
    this.name = "SpecialistPresetTypeError";
  }
}

class SpecialistPresetConfigError extends Error {
  configPath;
  cause;
  constructor(configPath, cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`failed to load presets from ${configPath}: ${message}`);
    this.configPath = configPath;
    this.cause = cause;
    this.name = "SpecialistPresetConfigError";
  }
}

class SpecialistPresetFieldMissingError extends Error {
  presetName;
  specialist;
  fieldPath;
  definedKeys;
  constructor(presetName, specialist, fieldPath, definedKeys) {
    super(`preset "${presetName}" referenced by ${formatReferenceLocation(specialist, fieldPath)} does not define ${fieldPath}. Defined keys: ${definedKeys.join(", ") || "(none)"}`);
    this.presetName = presetName;
    this.specialist = specialist;
    this.fieldPath = fieldPath;
    this.definedKeys = definedKeys;
    this.name = "SpecialistPresetFieldMissingError";
  }
}
function loadPresets(options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  if (presetsCache && presetsCacheBaseDir === baseDir && !options.force)
    return presetsCache;
  const paths = [
    join9(baseDir, "config", "presets.json"),
    join9(baseDir, "config", "specialists", "presets.json")
  ];
  for (const path of paths) {
    if (!existsSync13(path))
      continue;
    try {
      presetsCache = JSON.parse(readFileSync8(path, "utf-8"));
      presetsCacheBaseDir = baseDir;
      return presetsCache;
    } catch (error) {
      presetsCache = null;
      presetsCacheBaseDir = null;
      throw new SpecialistPresetConfigError(path, error);
    }
  }
  presetsCache = {};
  presetsCacheBaseDir = baseDir;
  return presetsCache;
}
function resolvePresetReference(value, fieldPath, presets, visited = new Set, options = {}) {
  if (!isPresetReference(value))
    return { value, depth: visited.size };
  const presetName = value.slice(PRESET_REFERENCE_PREFIX.length);
  if (visited.has(presetName)) {
    throw new SpecialistPresetCycleError([...visited, presetName], options.specialist, fieldPath);
  }
  if (visited.size >= PRESET_REFERENCE_MAX_DEPTH) {
    throw new SpecialistPresetCycleError([...visited, presetName], options.specialist, fieldPath);
  }
  const preset = presets[presetName];
  if (!preset) {
    throw new SpecialistPresetNotFoundError(presetName, options.specialist, fieldPath, Object.keys(presets));
  }
  if (!Object.prototype.hasOwnProperty.call(preset.fields, fieldPath)) {
    throw new SpecialistPresetFieldMissingError(presetName, options.specialist, fieldPath, Object.keys(preset.fields));
  }
  const nextValue = preset.fields[fieldPath];
  const nextVisited = new Set([...visited, presetName]);
  const resolved = resolvePresetReference(nextValue, fieldPath, presets, nextVisited, options);
  validateResolvedPresetValue(resolved.value, fieldPath, presetName, options);
  return { value: resolved.value, presetName, depth: resolved.depth };
}
function isPresetReference(value) {
  return typeof value === "string" && value.startsWith(PRESET_REFERENCE_PREFIX);
}
function validateResolvedPresetValue(value, fieldPath, presetName, options) {
  const expectedType = getExpectedPresetValueType(fieldPath, options.arrayEntry === true);
  if (!expectedType)
    return;
  if (matchesExpectedPresetValueType(value, expectedType))
    return;
  throw new SpecialistPresetTypeError(presetName, options.specialist, fieldPath, formatExpectedType(expectedType), formatActualType(value));
}
function getExpectedPresetValueType(fieldPath, isArrayEntry) {
  if (fieldPath === "specialist.execution.fallback_models" && isArrayEntry)
    return "string-or-null";
  switch (fieldPath) {
    case "specialist.execution.model":
    case "specialist.execution.fallback_model":
    case "specialist.execution.thinking_level":
      return "string-or-null";
    case "specialist.execution.fallback_models":
      return "string-array-or-null";
    case "specialist.execution.stall_timeout_ms":
      return "number";
    default:
      return null;
  }
}
function matchesExpectedPresetValueType(value, expectedType) {
  switch (expectedType) {
    case "string-or-null":
      return value === null || typeof value === "string";
    case "string-array-or-null":
      return value === null || Array.isArray(value) && value.every((entry) => typeof entry === "string");
    case "number":
      return typeof value === "number";
    default:
      return expectedType;
  }
}
function formatExpectedType(expectedType) {
  switch (expectedType) {
    case "string-or-null":
      return "string or null";
    case "string-array-or-null":
      return "string[] or null";
    case "number":
      return "number";
    default:
      return expectedType;
  }
}
function formatActualType(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return `array(${value.map(formatActualType).join(", ")})`;
  return typeof value;
}
function formatReferenceLocation(specialist, fieldPath) {
  return specialist ? `${specialist}.${fieldPath}` : fieldPath;
}

// src/specialist/project-pack-skill-resolver.ts
import { accessSync as accessSync2, constants as constants2, readdirSync, lstatSync as lstatSync3, realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join10, relative as relative2, isAbsolute as isAbsolute3 } from "node:path";
var RESERVED_SKILL_ROOTS = [
  "default",
  "optional",
  "user",
  "active",
  "local-legacy"
];

class ProjectPackSkillAmbiguityError extends Error {
  skillName;
  consumerRoot;
  matches;
  constructor(skillName, consumerRoot, matches, displayLines) {
    super(`skills.paths: logical skill '${escapeDiagnostic(skillName)}' is ambiguous — matches more than one project pack:
` + `${displayLines.map((line) => `    ${escapeDiagnostic(line)}`).join(`
`)}
` + `Disambiguate with an explicit path: .xtrm/skills/<pack>/<skill> (consumer-relative), an absolute path, or a ~/ path.`);
    this.skillName = skillName;
    this.consumerRoot = consumerRoot;
    this.matches = matches;
    this.name = "ProjectPackSkillAmbiguityError";
  }
}

class ProjectPackSkillSecurityError extends Error {
  skillName;
  repoRelativePath;
  constructor(skillName, repoRelativePath, detail) {
    super(`skills.paths: logical skill '${escapeDiagnostic(skillName)}' — '${escapeDiagnostic(repoRelativePath)}' ${detail}`);
    this.skillName = skillName;
    this.repoRelativePath = repoRelativePath;
    this.name = "ProjectPackSkillSecurityError";
  }
}
function escapeDiagnostic(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    const codeHex = (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0");
    return `\\u${codeHex}`;
  });
}
function wrapFsError(skillName, repoRelativePath, operation, error) {
  const code = escapeDiagnostic(error?.code ?? "UNKNOWN");
  const wrapped = new ProjectPackSkillSecurityError(skillName, repoRelativePath, `is not usable (${code}) while ${operation}; rejected`);
  Object.assign(wrapped, { cause: error });
  return wrapped;
}
function isBareLogicalSkillName(declared) {
  if (declared.length === 0)
    return false;
  if (declared === "." || declared === "..")
    return false;
  if (declared.startsWith("~"))
    return false;
  return !declared.includes("/") && !declared.includes("\\");
}
function resolveSkillPath(declared, ctx) {
  if (declared.startsWith("~/"))
    return join10(process.env.HOME || "", declared.slice(2));
  if (declared.startsWith("./"))
    return join10(ctx.fileDir, declared.slice(2));
  if (isBareLogicalSkillName(declared))
    return resolveBareLogicalSkill(declared, ctx.consumerRoot);
  return declared;
}
function isPathInside(candidate, root) {
  const rel = relative2(root, candidate);
  return rel === "" || rel.length > 0 && !rel.startsWith("..") && !isAbsolute3(rel);
}
function globalDefaultCandidate(skillName) {
  return join10(homedir6(), ".xtrm", "skills", "default", skillName);
}
function probeCandidate(skillName, canonicalConsumer, canonicalSkillsRoot, candidate) {
  const candidateRel = relative2(canonicalConsumer, candidate);
  let dirStat;
  try {
    dirStat = lstatSync3(candidate);
  } catch (error) {
    if (error?.code === "ENOENT")
      return null;
    throw wrapFsError(skillName, candidateRel, "probing the skill directory", error);
  }
  if (dirStat.isSymbolicLink()) {
    throw new ProjectPackSkillSecurityError(skillName, candidateRel, "is a symlink; symlinked skill directories are rejected");
  }
  if (!dirStat.isDirectory()) {
    throw new ProjectPackSkillSecurityError(skillName, candidateRel, "is not a directory (ENOTDIR); expected a skill directory");
  }
  const skillFile = join10(candidate, "SKILL.md");
  const skillFileRel = relative2(canonicalConsumer, skillFile);
  let mdStat;
  try {
    mdStat = lstatSync3(skillFile);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ProjectPackSkillSecurityError(skillName, skillFileRel, "is missing SKILL.md (ENOENT); a discovered skill directory must contain a regular SKILL.md file");
    }
    throw wrapFsError(skillName, skillFileRel, "probing the skill file", error);
  }
  if (mdStat.isSymbolicLink()) {
    throw new ProjectPackSkillSecurityError(skillName, skillFileRel, "is a symlink; symlinked SKILL.md files are rejected");
  }
  if (!mdStat.isFile()) {
    throw new ProjectPackSkillSecurityError(skillName, skillFileRel, "exists but is not a regular file; expected SKILL.md as a file");
  }
  try {
    accessSync2(skillFile, constants2.R_OK);
  } catch (error) {
    throw wrapFsError(skillName, skillFileRel, "checking skill file readability", error);
  }
  let canonicalCandidate;
  let canonicalSkillFile;
  try {
    canonicalCandidate = realpathSync2(candidate);
    canonicalSkillFile = realpathSync2(skillFile);
  } catch (error) {
    throw wrapFsError(skillName, candidateRel, "canonicalizing the skill path", error);
  }
  if (!isPathInside(canonicalCandidate, canonicalSkillsRoot) || !isPathInside(canonicalSkillFile, canonicalSkillsRoot)) {
    throw new ProjectPackSkillSecurityError(skillName, candidateRel, "resolves outside the consumer skills root; rejected");
  }
  return canonicalCandidate;
}
function resolveBareLogicalSkill(skillName, consumerRoot) {
  let canonicalConsumer;
  try {
    canonicalConsumer = realpathSync2(consumerRoot);
  } catch (error) {
    if (error?.code === "ENOENT")
      return globalDefaultCandidate(skillName);
    throw wrapFsError(skillName, ".", "resolving the consumer root", error);
  }
  const skillsRoot = join10(canonicalConsumer, ".xtrm", "skills");
  let canonicalSkillsRoot;
  try {
    canonicalSkillsRoot = realpathSync2(skillsRoot);
  } catch (error) {
    if (error?.code === "ENOENT")
      return globalDefaultCandidate(skillName);
    throw wrapFsError(skillName, ".xtrm/skills", "resolving the skills root", error);
  }
  if (!isPathInside(canonicalSkillsRoot, canonicalConsumer)) {
    throw new ProjectPackSkillSecurityError(skillName, ".xtrm/skills", "resolves outside the consumer root; rejected");
  }
  let packs = [];
  let entries;
  try {
    entries = readdirSync(canonicalSkillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT")
      return globalDefaultCandidate(skillName);
    throw wrapFsError(skillName, ".xtrm/skills", "listing the skills root", error);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      if (!RESERVED_SKILL_ROOTS.includes(entry.name)) {
        throw new ProjectPackSkillSecurityError(skillName, join10(".xtrm", "skills", entry.name), "is a symlink; symlinked pack directories are rejected");
      }
      continue;
    }
    if (!entry.isDirectory())
      continue;
    if (RESERVED_SKILL_ROOTS.includes(entry.name))
      continue;
    packs.push(entry.name);
  }
  packs.sort();
  const matches = [];
  for (const pack of packs) {
    const candidate = join10(canonicalSkillsRoot, pack, skillName);
    const resolved = probeCandidate(skillName, canonicalConsumer, canonicalSkillsRoot, candidate);
    if (resolved)
      matches.push(resolved);
  }
  matches.sort();
  if (matches.length > 1) {
    throw new ProjectPackSkillAmbiguityError(skillName, consumerRoot, matches, matches.map((m) => relative2(canonicalConsumer, m)));
  }
  if (matches.length === 1)
    return matches[0];
  return globalDefaultCandidate(skillName);
}

// src/specialist/loader.ts
class SpecialistMissingModelError extends Error {
  specialistName;
  constructor(specialistName) {
    super(`specialist '${specialistName}' has no model configured. ` + `Run: sp edit --global ${specialistName}.execution.model <model-id> ` + `(or 'sp init --global' to create the global user config file first).`);
    this.specialistName = specialistName;
    this.name = "SpecialistMissingModelError";
  }
}

class SpecialistExtensionSourceCollisionError extends Error {
  constructor(specialistName, packageName) {
    super(`specialist '${specialistName}' resolves multiple enabled npm extension sources for package '${packageName}' ` + `(distinct specs across config layers). Refusing to forward: keep exactly one spec per package, ` + `pinned to an exact reviewed version.`);
    this.name = "SpecialistExtensionSourceCollisionError";
  }
}
class SpecialistLoader {
  cache = new Map;
  blockedFieldWarnings = new Map;
  projectDir;
  constructor(options = {}) {
    this.projectDir = options.projectDir ?? process.cwd();
  }
  getScanDirs() {
    const dirs = [
      { path: join11(this.projectDir, ".specialists", "user"), scope: "user", source: "user" },
      { path: join11(this.projectDir, ".specialists", "user", "specialists"), scope: "user", source: "legacy" },
      { path: join11(this.projectDir, "config", "specialists"), scope: "package", source: "package-fallback" },
      { path: resolveCanonicalAssetDir("specialists") ?? "", scope: "package", source: "package-live" }
    ];
    return dirs.filter((d) => d.path && existsSync14(d.path));
  }
  toJson(content, isYaml) {
    if (!isYaml)
      return content;
    return JSON.stringify($parse(content));
  }
  resolveSpecialistPath(dirPath, specialistName) {
    const jsonPath = join11(dirPath, `${specialistName}.specialist.json`);
    if (existsSync14(jsonPath)) {
      return { filePath: jsonPath, deprecatedYaml: false };
    }
    const yamlPath = join11(dirPath, `${specialistName}.specialist.yaml`);
    if (existsSync14(yamlPath)) {
      return { filePath: yamlPath, deprecatedYaml: true };
    }
    return null;
  }
  findLayerHits(name) {
    const hits = [];
    const seenScopes = new Set;
    for (const dir of this.getScanDirs()) {
      const resolved = this.resolveSpecialistPath(dir.path, name);
      if (!resolved)
        continue;
      if (seenScopes.has(dir.scope))
        continue;
      seenScopes.add(dir.scope);
      hits.push({ dir, resolved });
    }
    return hits.reverse();
  }
  applyOverrideFields(name, base, override, source) {
    const warnings = [];
    const baseSpec = base.specialist;
    const overrideSpec = override.specialist ?? override;
    for (const dottedPath of BLOCKED_OVERRIDE_FIELDS) {
      const value = readDottedPath(overrideSpec, dottedPath);
      if (value === undefined)
        continue;
      warnings.push({
        specialist: name,
        field: dottedPath,
        source,
        severity: source === "global" ? "strip" : "warn",
        value
      });
    }
    const overrideExecution = overrideSpec.execution ?? {};
    const baseExecution = baseSpec.execution ?? {};
    for (const field of OVERRIDE_ALLOWED_EXECUTION_FIELDS) {
      if (!(field in overrideExecution))
        continue;
      const overrideValue = overrideExecution[field];
      if (overrideValue === null || overrideValue === undefined)
        continue;
      baseExecution[field] = this.resolveOverrideValue(name, `specialist.execution.${field}`, overrideValue);
    }
    mergeExecutionExtensionOverrides({
      specialist: name,
      baseExecution,
      overrideExecution,
      resolveValue: (path, value) => this.resolveOverrideValue(name, `specialist.execution.${path}`, value)
    });
    baseSpec.execution = baseExecution;
    const overridePrompt = overrideSpec.prompt ?? {};
    const basePrompt = baseSpec.prompt ?? {};
    for (const field of OVERRIDE_ALLOWED_PROMPT_FIELDS) {
      if (!(field in overridePrompt))
        continue;
      const overrideValue = overridePrompt[field];
      if (overrideValue === null || overrideValue === undefined)
        continue;
      basePrompt[field] = this.resolveOverrideValue(name, `specialist.prompt.${field}`, overrideValue);
    }
    baseSpec.prompt = basePrompt;
    const overrideStallDetection = overrideSpec.stall_detection ?? {};
    const baseStallDetection = baseSpec.stall_detection ?? {};
    for (const path of OVERRIDE_ALLOWED_STALL_DETECTION_PATHS) {
      const overrideValue = readDottedPath(overrideStallDetection, path);
      if (overrideValue === null || overrideValue === undefined)
        continue;
      writeDottedPath(baseStallDetection, path, this.resolveOverrideValue(name, `specialist.stall_detection.${path}`, overrideValue));
    }
    if (Object.keys(baseStallDetection).length > 0) {
      baseSpec.stall_detection = baseStallDetection;
    }
    for (const field of OVERRIDE_ALLOWED_TOP_FIELDS) {
      if (!(field in overrideSpec))
        continue;
      const overrideValue = overrideSpec[field];
      if (overrideValue === null || overrideValue === undefined)
        continue;
      baseSpec[field] = this.resolveOverrideValue(name, `specialist.${field}`, overrideValue);
    }
    const overrideSkills = overrideSpec.skills ?? {};
    const overridePaths = Array.isArray(overrideSkills.paths) ? overrideSkills.paths : null;
    if (overridePaths && overridePaths.length) {
      const baseSkills = baseSpec.skills ?? {};
      const basePaths = Array.isArray(baseSkills.paths) ? baseSkills.paths : [];
      const seen = new Set;
      const merged = [];
      for (const p of [...basePaths, ...overridePaths]) {
        if (seen.has(p))
          continue;
        seen.add(p);
        merged.push(p);
      }
      baseSkills.paths = merged;
      baseSpec.skills = baseSkills;
    }
    const overrideMandatoryRules = overrideSpec.mandatory_rules ?? {};
    for (const field of OVERRIDE_ALLOWED_MANDATORY_RULES_FIELDS) {
      if (!(field in overrideMandatoryRules))
        continue;
      const overrideValue = overrideMandatoryRules[field];
      if (overrideValue === null || overrideValue === undefined)
        continue;
      if (!Array.isArray(overrideValue))
        continue;
      const baseMandatoryRules = baseSpec.mandatory_rules ?? {};
      const safeIds = [];
      for (const rawId of overrideValue) {
        if (typeof rawId === "string" && /^[a-z][a-z0-9-]*$/.test(rawId)) {
          safeIds.push(rawId);
        } else {
          process.stderr.write(`[specialists] mandatory_rules.template_sets: dropping invalid set id '${String(rawId)}' for '${name}' (must be kebab-case)
`);
        }
      }
      baseMandatoryRules[field] = safeIds;
      baseSpec.mandatory_rules = baseMandatoryRules;
    }
    return warnings;
  }
  resolveOverrideValue(name, fieldPath, value, isArrayEntry = false) {
    if (Array.isArray(value)) {
      return value.map((entry) => this.resolveOverrideValue(name, fieldPath, entry, true));
    }
    const resolution = resolvePresetReference(value, fieldPath, loadPresets({ baseDir: this.projectDir }), new Set, { specialist: name, arrayEntry: isArrayEntry });
    if (resolution.presetName)
      emitPresetResolved(name, fieldPath, resolution.presetName, resolution.value, resolution.depth);
    return resolution.value;
  }
  async buildMergedSpec(name) {
    const hits = this.findLayerHits(name);
    if (hits.length === 0)
      return null;
    const baseHit = hits[0];
    const baseContent = await readFile(baseHit.resolved.filePath, "utf-8");
    const base = await parseSpecialist(this.toJson(baseContent, baseHit.resolved.deprecatedYaml));
    if (baseHit.resolved.deprecatedYaml) {
      process.stderr.write(`[specialists] DEPRECATED: YAML specialist config detected at ${baseHit.resolved.filePath}. Please migrate to .specialist.json
`);
    }
    this.resolveCanonicalPresetReferences(name, base);
    const warnings = [];
    const globalLocation = getGlobalUserConfigPath();
    const globalConfig = globalLocation.exists ? readGlobalUserConfig(globalLocation) : null;
    const globalOverride = globalConfig?.[name];
    if (globalOverride) {
      warnings.push(...this.applyOverrideFields(name, base, { specialist: globalOverride }, "global"));
    }
    for (const hit of hits.slice(1)) {
      const content = await readFile(hit.resolved.filePath, "utf-8");
      let overrideRaw;
      try {
        overrideRaw = JSON.parse(this.toJson(content, hit.resolved.deprecatedYaml));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[specialists] skipping override ${hit.resolved.filePath}: ${msg}
`);
        continue;
      }
      if (hit.resolved.deprecatedYaml) {
        process.stderr.write(`[specialists] DEPRECATED: YAML specialist config detected at ${hit.resolved.filePath}. Please migrate to .specialist.json
`);
      }
      warnings.push(...this.applyOverrideFields(name, base, overrideRaw, "user"));
    }
    const top = hits[hits.length - 1];
    resolveSkillsPaths(base, baseHit.dir.path, this.projectDir);
    return {
      spec: base,
      topLayer: {
        scope: top.dir.scope,
        source: top.dir.source,
        filePath: top.resolved.filePath,
        deprecatedYaml: top.resolved.deprecatedYaml
      },
      warnings
    };
  }
  resolveCanonicalPresetReferences(name, spec) {
    const execution = spec.specialist.execution;
    for (const field of OVERRIDE_ALLOWED_EXECUTION_FIELDS) {
      if (!(field in execution))
        continue;
      const value = execution[field];
      if (value === null || value === undefined)
        continue;
      execution[field] = this.resolveOverrideValue(name, `specialist.execution.${field}`, value);
    }
    mergeExecutionExtensionOverrides({
      specialist: name,
      baseExecution: execution,
      overrideExecution: execution,
      resolveValue: (path, value) => this.resolveOverrideValue(name, `specialist.execution.${path}`, value)
    });
  }
  async list(category) {
    const results = [];
    const seen = new Set;
    for (const dir of this.getScanDirs()) {
      const files = await readdir(dir.path).catch(() => []);
      for (const file of files.filter((f) => f.endsWith(".specialist.json") || f.endsWith(".specialist.yaml"))) {
        const specialistName = basename3(file).replace(/\.specialist\.(json|yaml)$/, "");
        if (seen.has(specialistName))
          continue;
        try {
          const merged = await this.buildMergedSpec(specialistName);
          if (!merged)
            continue;
          const { name, description, category: cat, version, updated } = merged.spec.specialist.metadata;
          if (seen.has(name))
            continue;
          if (category && cat !== category)
            continue;
          seen.add(name);
          if (merged.warnings.length)
            this.blockedFieldWarnings.set(name, merged.warnings);
          results.push({
            name,
            description,
            category: cat,
            version,
            model: merged.spec.specialist.execution.model ?? "",
            permission_required: merged.spec.specialist.execution.permission_required,
            interactive: merged.spec.specialist.execution.interactive,
            thinking_level: merged.spec.specialist.execution.thinking_level,
            skills: merged.spec.specialist.skills?.paths ?? [],
            scripts: merged.spec.specialist.skills?.scripts ?? [],
            mandatoryRuleTemplateSets: merged.spec.specialist.mandatory_rules?.template_sets ?? [],
            scope: merged.topLayer.scope,
            source: merged.topLayer.source,
            filePath: merged.topLayer.filePath,
            updated,
            filestoWatch: merged.spec.specialist.validation?.files_to_watch,
            staleThresholdDays: merged.spec.specialist.validation?.stale_threshold_days,
            stallDetection: merged.spec.specialist.stall_detection ?? undefined
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[specialists] skipping ${file} (${specialistName}): ${reason}
`);
        }
      }
    }
    return results;
  }
  async get(name) {
    if (this.cache.has(name))
      return this.cache.get(name);
    const merged = await this.buildMergedSpec(name);
    if (!merged)
      throw new Error(`Specialist not found: ${name}`);
    if (merged.warnings.length)
      this.blockedFieldWarnings.set(name, merged.warnings);
    const model = merged.spec.specialist.execution.model;
    if (model === null || model === undefined || model === "") {
      throw new SpecialistMissingModelError(name);
    }
    this.cache.set(name, merged.spec);
    return merged.spec;
  }
  async getEffective(name) {
    const merged = await this.buildMergedSpec(name);
    if (!merged)
      return null;
    if (merged.warnings.length)
      this.blockedFieldWarnings.set(name, merged.warnings);
    return merged.spec;
  }
  getBlockedFieldWarnings(name) {
    if (name)
      return this.blockedFieldWarnings.get(name) ?? [];
    const all = [];
    for (const warnings of this.blockedFieldWarnings.values())
      all.push(...warnings);
    return all;
  }
  getGlobalLayerPath() {
    try {
      return getGlobalUserConfigPath();
    } catch {
      return null;
    }
  }
  invalidateCache(name) {
    if (name) {
      this.cache.delete(name);
      this.blockedFieldWarnings.delete(name);
    } else {
      this.cache.clear();
      this.blockedFieldWarnings.clear();
    }
  }
}
var PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function mergeExecutionExtensionOverrides(options) {
  for (const path of OVERRIDE_ALLOWED_NESTED_EXECUTION_PATHS) {
    if (path !== "extensions")
      continue;
    const overrideValue = readDottedPath(options.overrideExecution, path);
    if (!overrideValue || typeof overrideValue !== "object" || Array.isArray(overrideValue))
      continue;
    const baseValue = readDottedPath(options.baseExecution, path);
    const mergedExtensions = {
      ...baseValue && typeof baseValue === "object" && !Array.isArray(baseValue) ? baseValue : {}
    };
    for (const [key, value] of Object.entries(overrideValue)) {
      if (value === null || value === undefined)
        continue;
      mergedExtensions[key] = options.resolveValue(`${path}.${key}`, value);
    }
    rejectNpmSourceCollisions(options.specialist, mergedExtensions);
    writeDottedPath(options.baseExecution, path, mergedExtensions);
  }
}
var NPM_NAME_RE = /^[a-z0-9][a-z0-9._~-]{0,213}$/;
var NPM_SCOPED_NAME_RE = /^@[a-z0-9][a-z0-9._~-]{0,212}\/[a-z0-9][a-z0-9._~-]{0,213}$/;
function parseNpmSourceName(key) {
  if (!key.startsWith("npm:"))
    return null;
  const spec = key.slice("npm:".length);
  let name;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 0)
      return null;
    const rest = spec.slice(slash + 1);
    const at = rest.indexOf("@");
    name = at < 0 ? spec : spec.slice(0, slash + 1 + at);
  } else {
    const at = spec.indexOf("@");
    name = at < 0 ? spec : spec.slice(0, at);
  }
  return name.length <= 214 && (name.startsWith("@") ? NPM_SCOPED_NAME_RE.test(name) : NPM_NAME_RE.test(name)) ? name : null;
}
function rejectNpmSourceCollisions(specialist, extensions) {
  const seen = new Map;
  for (const [key, value] of Object.entries(extensions)) {
    if (value !== true)
      continue;
    const name = parseNpmSourceName(key);
    if (!name)
      continue;
    const existing = seen.get(name);
    if (existing !== undefined && existing !== key) {
      throw new SpecialistExtensionSourceCollisionError(specialist, name);
    }
    seen.set(name, key);
  }
}
function readDottedPath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object")
      return;
    if (PROTOTYPE_POLLUTION_KEYS.has(part))
      return;
    if (!Object.prototype.hasOwnProperty.call(cur, part))
      return;
    cur = cur[part];
  }
  return cur;
}
function writeDottedPath(obj, dotted, value) {
  const parts = dotted.split(".");
  const leaf = parts.pop();
  if (!leaf || PROTOTYPE_POLLUTION_KEYS.has(leaf))
    return;
  let cur = obj;
  for (const part of parts) {
    if (PROTOTYPE_POLLUTION_KEYS.has(part))
      return;
    const next = cur[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[leaf] = value;
}
function emitPresetResolved(specialist, field, presetName, resolvedValue, depth) {
  process.stderr.write(`${JSON.stringify({
    event: "preset_resolved",
    specialist,
    field,
    preset_name: presetName,
    resolved_value: resolvedValue,
    depth
  })}
`);
}
function resolveSkillsPaths(spec, fileDir, consumerRoot) {
  const rawPaths = spec.specialist.skills?.paths;
  if (!rawPaths?.length)
    return;
  const resolved = rawPaths.map((p) => resolveSkillPath(p, { consumerRoot, fileDir }));
  spec.specialist.skills.paths = resolved;
}
// src/activation/native-host.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// src/activation/bead-gate.ts
import { spawnSync as spawnSync4 } from "node:child_process";
var REQUIRED_SECTIONS = [
  "PROBLEM",
  "SUCCESS",
  "SCOPE",
  "NON_GOALS",
  "CONSTRAINTS",
  "VALIDATION",
  "OUTPUT"
];
var SCRUTINY_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
var NON_DISPATCHABLE_STATUSES = new Set(["closed", "deferred"]);
function readContractState(beadId) {
  const result = spawnSync4("bd", ["state", beadId, "contract"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000
  });
  if (result.error || result.status !== 0)
    return;
  const value = result.stdout?.trim().toLowerCase();
  return value ? value : undefined;
}
var ALL_HEADINGS = new Set([...REQUIRED_SECTIONS, "SCRUTINY"]);
function headingOf(line) {
  const bare = line.trim().replace(/^#+\s*/, "").replace(/\*/g, "").replace(/:$/, "").trim();
  const normalized = bare.toUpperCase().replace(/[\s-]+/g, "_");
  return ALL_HEADINGS.has(normalized) ? normalized : undefined;
}
function extractSections(description) {
  const sections = new Map;
  let current;
  let body = [];
  const flush = () => {
    if (current)
      sections.set(current, body.join(`
`).trim());
  };
  for (const line of description.split(`
`)) {
    const heading = headingOf(line);
    if (heading) {
      flush();
      current = heading;
      body = [];
      continue;
    }
    if (current)
      body.push(line);
  }
  flush();
  return sections;
}
function scrutinyLevel(description) {
  const match = description.match(/SCRUTINY\b[^\n]*\n?\s*\**\s*(LOW|MEDIUM|HIGH|CRITICAL)\b/i) ?? description.match(/SCRUTINY\b\s*[:\-—]?\s*(LOW|MEDIUM|HIGH|CRITICAL)\b/i);
  return match?.[1]?.toUpperCase();
}
function evaluateBeadReadiness(bead, options = {}) {
  const status = bead.status?.trim().toLowerCase();
  if (status && NON_DISPATCHABLE_STATUSES.has(status)) {
    return { ok: false, reason: `bead is ${status} and is not dispatchable`, missing: [] };
  }
  const contractState = (options.readContractState ?? readContractState)(bead.id);
  if (contractState === "draft") {
    return {
      ok: false,
      reason: "bead contract is marked draft — promote it with `bd set-state <id> contract=ready` first",
      missing: []
    };
  }
  const description = bead.description ?? "";
  const sections = extractSections(description);
  const missing = REQUIRED_SECTIONS.filter((section) => !sections.get(section));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "bead is not a usable task contract: required sections are missing or empty",
      missing: [...missing]
    };
  }
  if (!scrutinyLevel(description)) {
    return {
      ok: false,
      reason: `bead declares no SCRUTINY level (expected one of ${SCRUTINY_LEVELS.join(", ")})`,
      missing: ["SCRUTINY"]
    };
  }
  return { ok: true };
}

// src/activation/step-contract.ts
function toList(body) {
  if (!body)
    return [];
  return body.split(`
`).map((line) => line.trim().replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim()).filter((line) => line.length > 0);
}
function compileStepContract(input) {
  const { bead, specialist } = input;
  const now = input.now ?? (() => Date.now());
  const sections = extractSections(bead.description ?? "");
  const scopeText = sections.get("SCOPE") ?? "";
  const successText = sections.get("SUCCESS") ?? "";
  const mandate = [successText, scopeText].filter(Boolean).join(`

`);
  const inputs = [
    { kind: "bead", ref: bead.id, title: bead.title },
    ...(bead.dependencies ?? []).filter((dep) => typeof dep?.id === "string" && dep.id.length > 0).map((dep) => ({ kind: "blocker", ref: dep.id }))
  ];
  const outputText = sections.get("OUTPUT") ?? "";
  const outputs = outputText ? [{ description: outputText, ...input.responseFormat ? { format: input.responseFormat } : {} }] : [];
  const constraints = toList(sections.get("CONSTRAINTS"));
  const validation = toList(sections.get("VALIDATION")).map((description) => ({ description }));
  const revision = bead.revision;
  return {
    rootWorkRef: bead.id,
    mandate,
    inputs,
    outputs,
    scope: { inScope: scopeText },
    nonGoals: toList(sections.get("NON_GOALS")),
    ...constraints.length > 0 ? { constraints } : {},
    ...validation.length > 0 ? { validation } : {},
    provenance: {
      specialist,
      generatedAt: now(),
      ...revision === undefined || revision === null ? {} : { sourceBeadRevision: String(revision) }
    }
  };
}

// src/activation/interaction.ts
import { randomUUID as randomUUID2 } from "node:crypto";

class UncorrelatedReplyError extends Error {
  inReplyTo;
  constructor(inReplyTo) {
    super(inReplyTo ? `reply cites unknown or already-answered message "${inReplyTo}"` : "reply carries no inReplyTo — replies must be correlated by id, never by ordering");
    this.inReplyTo = inReplyTo;
    this.name = "UncorrelatedReplyError";
  }
}

class InteractionTransport {
  now;
  newId;
  deliver;
  pending = new Map;
  waiters = new Map;
  answered = new Map;
  log = [];
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => `msg:${randomUUID2().slice(0, 12)}`);
    this.deliver = options.deliver;
  }
  async send(input, messageId) {
    if (input.kind === "reply")
      return this.reply(input);
    const message = this.compose(input, messageId);
    this.log.push(message);
    const expectsAnswer = message.kind === "question" || message.kind === "escalation";
    if (expectsAnswer) {
      this.pending.set(message.messageId, {
        message,
        delivery: "pending",
        askedAt: message.createdAt
      });
    }
    const delivered = await this.attemptDelivery(message);
    const ask = this.pending.get(message.messageId);
    if (ask)
      ask.delivery = delivered ? "delivered" : "pending";
    return message;
  }
  async request(input) {
    const messageId = this.newId();
    const waited = new Promise((resolve10) => {
      this.waiters.set(messageId, resolve10);
    });
    await this.send({ ...input, kind: input.kind ?? "question" }, messageId);
    const early = this.answered.get(messageId);
    if (early) {
      this.waiters.delete(messageId);
      this.answered.delete(messageId);
      return early;
    }
    return waited;
  }
  async reply(input) {
    const target = input.inReplyTo;
    if (!target || !this.pending.has(target))
      throw new UncorrelatedReplyError(target);
    const message = this.compose(input);
    this.log.push(message);
    this.pending.delete(target);
    const waiter = this.waiters.get(target);
    if (waiter) {
      this.waiters.delete(target);
      waiter(message);
    }
    this.answered.set(target, message);
    await this.attemptDelivery(message);
    return message;
  }
  pendingAsks(participantId) {
    const asks = [...this.pending.values()].filter((ask) => !participantId || ask.message.from === participantId || ask.message.to === participantId);
    return asks.sort((a, b) => a.askedAt - b.askedAt);
  }
  attention(participantId) {
    return [...this.pending.values()].some((ask) => ask.message.to === participantId);
  }
  impliedState(activationId) {
    const asks = [...this.pending.values()].filter((a) => a.message.activationId === activationId);
    if (asks.some((a) => a.message.kind === "escalation"))
      return "escalated";
    return asks.length > 0 ? "needs_reply" : undefined;
  }
  history() {
    return [...this.log];
  }
  compose(input, messageId) {
    return {
      messageId: messageId ?? this.newId(),
      kind: input.kind,
      from: input.from,
      to: input.to,
      activationId: input.activationId,
      attemptId: input.attemptId,
      body: input.body,
      ...input.inReplyTo ? { inReplyTo: input.inReplyTo } : {},
      createdAt: this.now()
    };
  }
  async attemptDelivery(message) {
    if (!this.deliver)
      return true;
    try {
      return await this.deliver(message) === true;
    } catch {
      return false;
    }
  }
}

// src/activation/transport/pending-store.ts
import { existsSync as existsSync15, mkdirSync as mkdirSync5, readdirSync as readdirSync2, readFileSync as readFileSync9, renameSync as renameSync2, unlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join12 } from "node:path";
var KINDS_AWAITING_REPLY = new Set(["question", "escalation"]);
function createsPendingAsk(kind) {
  return KINDS_AWAITING_REPLY.has(kind);
}
function interactionsRoot(repoRoot) {
  return join12(repoRoot, ".specialists", "interactions");
}
function recordPath(repoRoot, activationId, messageId) {
  return join12(interactionsRoot(repoRoot), activationId, `${messageId}.json`);
}
function replyPath(repoRoot, activationId, messageId) {
  return join12(interactionsRoot(repoRoot), activationId, `${messageId}.reply.json`);
}
function writeAtomic(path, value, exclusive = false) {
  if (exclusive && existsSync15(path)) {
    throw new Error(`interaction record already exists: ${path}`);
  }
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync4(tmp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
  try {
    renameSync2(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}
function readJson(path) {
  if (!existsSync15(path))
    return;
  try {
    return JSON.parse(readFileSync9(path, "utf-8"));
  } catch {
    return;
  }
}
function create(repoRoot, input) {
  const record = {
    messageId: input.messageId,
    activationId: input.activationId,
    kind: input.kind,
    createdAtMs: input.createdAtMs ?? Date.now(),
    message: input.message,
    delivery: { state: "pending", attempts: [] }
  };
  mkdirSync5(join12(interactionsRoot(repoRoot), input.activationId), { recursive: true, mode: 448 });
  writeAtomic(recordPath(repoRoot, input.activationId, input.messageId), record, true);
  return record;
}
function read(repoRoot, activationId, messageId) {
  return readJson(recordPath(repoRoot, activationId, messageId));
}
function readReply(repoRoot, activationId, messageId) {
  return readJson(replyPath(repoRoot, activationId, messageId));
}
function recordAttempt(repoRoot, activationId, messageId, attempt) {
  const record = read(repoRoot, activationId, messageId);
  if (!record)
    throw new Error(`no interaction record for ${activationId}/${messageId}`);
  record.delivery.attempts.push(attempt);
  if (record.delivery.state !== "delivered") {
    record.delivery.state = attempt.outcome;
  }
  writeAtomic(recordPath(repoRoot, activationId, messageId), record);
  return record;
}
function recordReceipt(repoRoot, activationId, messageId, receipt) {
  const record = read(repoRoot, activationId, messageId);
  if (!record)
    throw new Error(`no interaction record for ${activationId}/${messageId}`);
  if (receipt.origMsgId !== messageId) {
    throw new Error(`receipt orig_msg_id ${receipt.origMsgId} does not match ${messageId}`);
  }
  record.delivery.state = "delivered";
  record.delivery.receiptMsgId = receipt.receiptMsgId;
  record.delivery.deliveredAtMs = receipt.atMs ?? Date.now();
  writeAtomic(recordPath(repoRoot, activationId, messageId), record);
  return record;
}
function isConfirmable(kind) {
  return createsPendingAsk(kind);
}
function recordReplyDelivery(repoRoot, activationId, messageId, reply) {
  const record = read(repoRoot, activationId, messageId);
  if (!record)
    throw new Error(`no interaction record for ${activationId}/${messageId}`);
  if (reply.inReplyTo !== messageId) {
    throw new Error(`reply inReplyTo ${String(reply.inReplyTo)} does not match ${messageId}`);
  }
  if (!isConfirmable(record.kind))
    return record;
  if (record.delivery.state !== "sent_unconfirmed")
    return record;
  record.delivery.state = "delivered";
  record.delivery.deliveredAtMs = reply.atMs ?? Date.now();
  writeAtomic(recordPath(repoRoot, activationId, messageId), record);
  return record;
}

// src/activation/peer-bridge.ts
var DEFAULT_REPLY_TIMEOUT_MS = 60 * 60 * 1000;
var DEFAULT_POLL_INTERVAL_MS = 500;
function createPeerDelivery(options) {
  const {
    transport,
    adapter,
    repoRoot,
    coordinatorSessionId,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    onPush,
    onReplyRouted
  } = options;
  const watched = new Set;
  const watchForReply = (message) => {
    if (watched.has(message.messageId))
      return;
    watched.add(message.messageId);
    const deadline = Date.now() + replyTimeoutMs;
    const tick = async () => {
      if (Date.now() > deadline) {
        watched.delete(message.messageId);
        return;
      }
      const stored = readReply(repoRoot, message.activationId, message.messageId);
      if (!stored) {
        setTimeout(() => void tick(), pollIntervalMs).unref?.();
        return;
      }
      watched.delete(message.messageId);
      try {
        const reply = await transport().send({
          kind: "reply",
          from: message.to,
          to: message.from,
          activationId: message.activationId,
          attemptId: message.attemptId,
          body: bodyOf(stored.body),
          inReplyTo: message.messageId
        });
        onReplyRouted?.(message, reply);
      } catch {}
    };
    setTimeout(() => void tick(), pollIntervalMs).unref?.();
  };
  return async (message) => {
    const result = await adapter.push({
      messageId: message.messageId,
      activationId: message.activationId,
      kind: message.kind,
      message,
      body: message.body,
      coordinatorSessionId
    });
    onPush?.(message, result);
    if (message.kind === "question" || message.kind === "escalation")
      watchForReply(message);
    return result.outcome === "delivered";
  };
}
function bodyOf(payload) {
  if (typeof payload === "string")
    return payload;
  if (payload && typeof payload === "object") {
    const body = payload.body;
    if (typeof body === "string")
      return body;
  }
  return String(payload ?? "");
}

// src/activation/transport/polling.ts
async function awaitReply(repoRoot, activationId, messageId, options) {
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;
  for (;; ) {
    const reply = readReply(repoRoot, activationId, messageId);
    if (reply)
      return reply;
    if (options.signal?.aborted)
      return;
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return;
    await sleep(Math.min(intervalMs, remaining), options.signal);
  }
}
function sleep(ms, signal) {
  return new Promise((resolve10) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve10();
    }
  });
}

// src/activation/transport/peer-transport.ts
import { connect, createServer } from "node:net";

// src/activation/transport/roster.ts
import { existsSync as existsSync16, readdirSync as readdirSync3, readFileSync as readFileSync10 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as join13 } from "node:path";
var SUPPORTED_PEER_PROTOCOL = 1;
function defaultRosterDir() {
  return join13(homedir7(), ".claude", "sessions");
}
function procProbe() {
  let bootSeconds;
  const ticksPerSecond = 100;
  return {
    startOf(pid) {
      try {
        if (bootSeconds === undefined) {
          const match = /^btime (\d+)$/m.exec(readFileSync10("/proc/stat", "utf-8"));
          if (!match)
            return;
          bootSeconds = Number(match[1]);
        }
        const stat2 = readFileSync10(`/proc/${pid}/stat`, "utf-8");
        const afterComm = stat2.slice(stat2.lastIndexOf(")") + 2).trim().split(/\s+/);
        const ticksSinceBoot = Number(afterComm[19]);
        if (!Number.isFinite(ticksSinceBoot))
          return;
        return { ticksSinceBoot, epochSeconds: bootSeconds + ticksSinceBoot / ticksPerSecond };
      } catch {
        return;
      }
    }
  };
}
var PROC_START_TOLERANCE_SECONDS = 2;
function procStartMatches(claim, actual) {
  if (typeof claim === "number")
    return claim === actual.ticksSinceBoot;
  const asNumber2 = Number(claim);
  if (claim.trim() !== "" && Number.isFinite(asNumber2))
    return asNumber2 === actual.ticksSinceBoot;
  const claimedMs = Date.parse(claim);
  if (!Number.isFinite(claimedMs))
    return false;
  return Math.abs(actual.epochSeconds - claimedMs / 1000) <= PROC_START_TOLERANCE_SECONDS;
}
function evaluateRegistration(registration, probe) {
  if (registration.peerProtocol !== SUPPORTED_PEER_PROTOCOL) {
    return { reason: "unsupported_peer_protocol" };
  }
  if (!registration.messagingSocketPath) {
    return { reason: "no_socket_path" };
  }
  if (registration.procStart === undefined || registration.procStart === null || registration.procStart === "") {
    return { reason: "missing_proc_start" };
  }
  const actualStart = probe.startOf(registration.pid);
  if (actualStart === undefined) {
    return { reason: "no_proc_entry" };
  }
  if (!procStartMatches(registration.procStart, actualStart)) {
    return { reason: "proc_start_mismatch" };
  }
  return {
    route: {
      routeRef: `pid:${registration.pid}/session:${registration.sessionId}`,
      pid: registration.pid,
      sessionId: registration.sessionId,
      socketPath: registration.messagingSocketPath,
      cwd: registration.cwd,
      name: registration.name,
      reportedStatus: registration.status
    }
  };
}
function scanRoster(options = {}) {
  const dir = options.dir ?? defaultRosterDir();
  const probe = options.probe ?? procProbe();
  const live = [];
  const rejected = [];
  if (!existsSync16(dir))
    return { live, rejected };
  for (const file of readdirSync3(dir)) {
    if (!file.endsWith(".json"))
      continue;
    let registration;
    try {
      registration = JSON.parse(readFileSync10(join13(dir, file), "utf-8"));
    } catch {
      rejected.push({ file, reason: "unparsable" });
      continue;
    }
    const verdict = evaluateRegistration(registration, probe);
    if ("route" in verdict)
      live.push(verdict.route);
    else
      rejected.push({ file, pid: registration.pid, reason: verdict.reason });
  }
  return { live, rejected };
}
function selectRoute(coordinatorSessionId, options = {}) {
  return scanRoster(options).live.find((route) => route.sessionId === coordinatorSessionId);
}

// src/activation/transport/peer-transport.ts
var MAX_LINE_BYTES = 1024 * 1024;
var ENVELOPE_TAG = "cross-session-message";
var escapeBody = (body) => body.replace(new RegExp(`</(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"), "<\\/");
function buildEnvelope(input) {
  const attrs = [];
  if (input.from)
    attrs.push(`from="${input.from}"`);
  if (input.fromName)
    attrs.push(`from-name="${input.fromName.replace(/["<>]/g, "")}"`);
  const prefix = attrs.length ? ` ${attrs.join(" ")}` : "";
  return `<${ENVELOPE_TAG}${prefix}>
${escapeBody(input.body)}
</${ENVELOPE_TAG}>`;
}
function buildUserFrame(input) {
  return {
    msgV: 1,
    msg_id: input.msgId,
    type: "user",
    priority: input.priority ?? "next",
    ...input.from ? { from: input.from } : {},
    ...input.sessionId ? { session_id: input.sessionId } : {},
    message: { role: "user", content: input.content }
  };
}
function sendFrame(socketPath, frame, timeoutMs = 5000) {
  return new Promise((resolve10, reject) => {
    const payload = `${JSON.stringify(frame)}
`;
    if (Buffer.byteLength(payload) > MAX_LINE_BYTES) {
      reject(new Error(`frame exceeds ${MAX_LINE_BYTES} bytes; the peer would drop the connection`));
      return;
    }
    const socket = connect({ path: socketPath });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`timed out writing to ${socketPath}`));
    });
    socket.on("error", reject);
    socket.on("connect", () => socket.end(payload, () => resolve10()));
  });
}

// src/activation/transport/peer-adapter.ts
class PeerAdapter {
  options;
  constructor(options) {
    this.options = options;
  }
  async push(request) {
    const { repoRoot, emit } = this.options;
    const existing = read(repoRoot, request.activationId, request.messageId);
    const record = existing ?? create(repoRoot, {
      messageId: request.messageId,
      activationId: request.activationId,
      kind: request.kind,
      message: request.message
    });
    const route = selectRoute(request.coordinatorSessionId, {
      dir: this.options.rosterDir,
      probe: this.options.probe
    });
    if (!route) {
      emit?.({ event: "peer.route_absent", activationId: request.activationId, messageId: request.messageId });
      return {
        outcome: "no_route",
        record: recordAttempt(repoRoot, request.activationId, request.messageId, {
          atMs: Date.now(),
          route: `session:${request.coordinatorSessionId}`,
          outcome: "undeliverable",
          detail: "no live registration matched this coordinator session"
        })
      };
    }
    emit?.({
      event: "peer.route_selected",
      activationId: request.activationId,
      messageId: request.messageId,
      routeRef: route.routeRef
    });
    const receiptTimeoutMs = this.options.receiptTimeoutMs ?? 1e4;
    const pendingReceipt = this.options.receipts?.waitForReceipt(request.messageId, receiptTimeoutMs);
    const frame = buildUserFrame({
      msgId: request.messageId,
      content: buildEnvelope({
        from: this.options.selfAddress,
        fromName: this.options.selfName,
        body: request.body
      }),
      from: this.options.selfAddress
    });
    try {
      await sendFrame(route.socketPath, frame);
    } catch (err) {
      emit?.({
        event: "peer.send_attempted",
        activationId: request.activationId,
        messageId: request.messageId,
        routeRef: route.routeRef,
        detail: String(err)
      });
      return {
        outcome: "send_failed",
        route,
        record: recordAttempt(repoRoot, request.activationId, request.messageId, {
          atMs: Date.now(),
          route: route.routeRef,
          outcome: "undeliverable",
          detail: err instanceof Error ? err.message : String(err)
        })
      };
    }
    recordAttempt(repoRoot, request.activationId, request.messageId, {
      atMs: Date.now(),
      route: route.routeRef,
      outcome: "sent_unconfirmed"
    });
    const receipt = await pendingReceipt;
    if (!receipt) {
      emit?.({
        event: "peer.no_receipt",
        activationId: request.activationId,
        messageId: request.messageId,
        routeRef: route.routeRef
      });
      return { outcome: "no_receipt", route, record: read(repoRoot, request.activationId, request.messageId) };
    }
    emit?.({
      event: "peer.receipt",
      activationId: request.activationId,
      messageId: request.messageId,
      routeRef: route.routeRef,
      detail: receipt.status
    });
    if (!isDeliveredStatus(receipt.status)) {
      return {
        outcome: "refused",
        route,
        reason: receipt.reason ?? receipt.status,
        record: recordAttempt(repoRoot, request.activationId, request.messageId, {
          atMs: Date.now(),
          route: route.routeRef,
          outcome: "refused",
          detail: receipt.reason ?? receipt.status
        })
      };
    }
    return {
      outcome: "delivered",
      route,
      record: recordReceipt(repoRoot, request.activationId, request.messageId, {
        origMsgId: request.messageId,
        receiptMsgId: receipt.msg_id
      })
    };
  }
  async ask(request, wait) {
    const push = await this.push(request);
    const reply = await awaitReply(this.options.repoRoot, request.activationId, request.messageId, wait);
    if (!reply)
      return { push };
    const inReplyTo = replyCorrelation(reply.body) ?? request.messageId;
    const record = recordReplyDelivery(this.options.repoRoot, request.activationId, request.messageId, {
      inReplyTo,
      atMs: reply.repliedAtMs
    });
    return { push: { ...push, record, outcome: outcomeAfterReply(push.outcome, record) }, reply: reply.body };
  }
}
function replyCorrelation(body) {
  if (typeof body !== "object" || body === null)
    return;
  const value = body.inReplyTo;
  return typeof value === "string" ? value : undefined;
}
function outcomeAfterReply(current, record) {
  return record.delivery.state === "delivered" && current !== "refused" ? "delivered" : current;
}
function isDeliveredStatus(status) {
  return status === "delivered" || status === "approved" || status === "released";
}

// src/activation/workspace-lease.ts
import { createHash as createHash5 } from "node:crypto";
import { existsSync as existsSync17, linkSync, mkdirSync as mkdirSync6, readFileSync as readFileSync11, realpathSync as realpathSync3, renameSync as renameSync3, unlinkSync as unlinkSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join14 } from "node:path";

// src/activation/types.ts
class DispatchRejectedError extends Error {
  reason;
  detail;
  constructor(reason, detail = {}) {
    const lines = [
      "SPECIALIST_DISPATCH_REJECTED",
      "",
      ...detail.activationId ? [`activation:
  ${detail.activationId}`, ""] : [],
      ...detail.beadId ? [`bead:
  ${detail.beadId}`, ""] : [],
      ...detail.specialist ? [`specialist:
  ${detail.specialist}`, ""] : [],
      ...detail.note ? [`note:
  ${detail.note}`, ""] : [],
      `reason:
  ${reason}`,
      ...detail.missing?.length ? ["", `missing:
${detail.missing.map((m) => `  - ${m}`).join(`
`)}`] : [],
      ...detail.requestedModel ? ["", `requested model:
  ${detail.requestedModel}`] : [],
      ...detail.workspace ? ["", `workspace:
  ${detail.workspace}`] : [],
      ...detail.holder ? ["", `holder:
  ${detail.holder}`] : [],
      "",
      `AgentSession:
  not created`
    ];
    super(lines.join(`
`));
    this.reason = reason;
    this.detail = detail;
    this.name = "DispatchRejectedError";
  }
}

// src/activation/workspace-lease.ts
function procLeaseProbe() {
  return {
    canVerify: () => existsSync17("/proc/self/stat"),
    startTicks(pid) {
      try {
        const stat2 = readFileSync11(`/proc/${pid}/stat`, "utf-8");
        const afterComm = stat2.slice(stat2.lastIndexOf(")") + 2).trim().split(/\s+/);
        const ticks = Number(afterComm[19]);
        return Number.isFinite(ticks) ? ticks : undefined;
      } catch {
        return;
      }
    }
  };
}
function selfHolder(probe = procLeaseProbe()) {
  const startTicks = probe.startTicks(process.pid);
  if (startTicks === undefined) {
    throw new Error("cannot read this process start time; a lease cannot be acquired without the PID-reuse guard");
  }
  return { pid: process.pid, startTicks };
}
function workspaceKey(workspace) {
  let resolved = workspace.worktreePath;
  try {
    resolved = realpathSync3(workspace.worktreePath);
  } catch {}
  return createHash5("sha256").update(resolved).digest("hex").slice(0, 16);
}
function leaseDir(workspace) {
  return join14(workspace.gitCommonDir ?? workspace.repositoryRoot, ".specialists", "leases");
}
function leasePath(workspace) {
  return join14(leaseDir(workspace), `${workspaceKey(workspace)}.json`);
}
function inspect(workspace, probe = procLeaseProbe()) {
  const path = leasePath(workspace);
  if (!existsSync17(path))
    return { state: "free" };
  let lease;
  try {
    lease = JSON.parse(readFileSync11(path, "utf-8"));
    if (typeof lease?.holder?.pid !== "number")
      throw new Error("missing holder");
  } catch {
    return { state: "uncertain", uncertainReason: "unreadable_record" };
  }
  if (!probe.canVerify()) {
    return { state: "uncertain", lease, uncertainReason: "liveness_unverifiable" };
  }
  const actual = probe.startTicks(lease.holder.pid);
  if (actual === undefined) {
    return { state: "uncertain", lease, uncertainReason: "holder_process_gone" };
  }
  if (actual !== lease.holder.startTicks) {
    return { state: "uncertain", lease, uncertainReason: "holder_start_mismatch" };
  }
  return { state: "held", lease };
}
function acquire(request, probe = procLeaseProbe()) {
  const { workspace, activationId, attemptId } = request;
  const path = leasePath(workspace);
  const status = inspect(workspace, probe);
  if (status.state === "held" && status.lease) {
    if (status.lease.activationId === activationId) {
      return rewrite(workspace, { ...status.lease, attemptId });
    }
    throw refusal("workspace_held_by_another_writer", request, status);
  }
  if (status.state === "uncertain") {
    throw refusal("workspace_lease_uncertain", request, status);
  }
  const lease = {
    workspaceKey: workspaceKey(workspace),
    worktreePath: workspace.worktreePath,
    activationId,
    attemptId,
    specialist: request.specialist,
    holder: selfHolder(probe),
    acquiredAtMs: Date.now()
  };
  mkdirSync6(leaseDir(workspace), { recursive: true, mode: 448 });
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync5(staging, `${JSON.stringify(lease, null, 2)}
`, { mode: 384 });
  try {
    linkSync(staging, path);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw refusal("workspace_held_by_another_writer", request, inspect(workspace, probe));
    }
    throw err;
  } finally {
    try {
      unlinkSync2(staging);
    } catch {}
  }
  return lease;
}
function rewrite(workspace, lease) {
  const path = leasePath(workspace);
  const staging = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync5(staging, `${JSON.stringify(lease, null, 2)}
`, { mode: 384 });
  renameSync3(staging, path);
  return lease;
}
function release(workspace, activationId, probe = procLeaseProbe()) {
  const status = inspect(workspace, probe);
  if (status.state === "free")
    return;
  if (status.state === "uncertain") {
    throw new DispatchRejectedError("workspace_lease_uncertain", {
      activationId,
      workspace: workspace.worktreePath,
      holder: describeHolder(status),
      note: "refusing to release a lease whose holder liveness is unknown; recovery is PRD Phase 9"
    });
  }
  if (status.lease && status.lease.activationId !== activationId) {
    throw new DispatchRejectedError("workspace_lease_not_held_by_caller", {
      activationId,
      workspace: workspace.worktreePath,
      holder: describeHolder(status)
    });
  }
  try {
    unlinkSync2(leasePath(workspace));
  } catch (err) {
    if (err.code !== "ENOENT")
      throw err;
  }
}
function describeHolder(status) {
  if (!status.lease)
    return status.uncertainReason ?? "unknown";
  const { activationId, specialist, holder } = status.lease;
  const who = specialist ? `${specialist} ` : "";
  const why = status.uncertainReason ? ` (${status.uncertainReason})` : "";
  return `${who}${activationId} pid ${holder.pid}${why}`;
}
function refusal(reason, request, status) {
  return new DispatchRejectedError(reason, {
    activationId: request.activationId,
    specialist: request.specialist,
    workspace: request.workspace.worktreePath,
    holder: describeHolder(status),
    note: status.state === "uncertain" ? "the previous holder's liveness could not be established; the lease is uncertain, not free" : "exactly one writer holds a mutable workspace at a time"
  });
}
var NON_MUTATING_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "search",
  "view",
  "todowrite",
  "websearch",
  "webfetch"
]);
function isMutatingTool(toolName) {
  return !NON_MUTATING_TOOLS.has(toolName.trim().toLowerCase());
}
function admitToolCall(input, probe = procLeaseProbe()) {
  if (!isMutatingTool(input.toolName))
    return { allow: true };
  const status = inspect(input.workspace, probe);
  if (status.state === "held" && status.lease?.activationId === input.activationId) {
    return { allow: true };
  }
  if (status.state === "held") {
    return {
      allow: false,
      reason: `workspace ${input.workspace.worktreePath} is held by ${describeHolder(status)}; ` + `${input.toolName} would mutate a workspace this activation does not hold`
    };
  }
  if (status.state === "uncertain") {
    return {
      allow: false,
      reason: `workspace ${input.workspace.worktreePath} lease is uncertain (${status.uncertainReason}); ` + "mutation is refused until recovery resolves the previous holder"
    };
  }
  return {
    allow: false,
    reason: `workspace ${input.workspace.worktreePath} is not leased by this activation; ` + `${input.toolName} may not mutate it`
  };
}

// src/activation/guarded-tools.ts
var FACTORY_NAMES = {
  edit: "createEditTool",
  write: "createWriteTool",
  bash: "createBashTool",
  powershell: "createPowerShellTool"
};
function createGuardedTools(sdk, input) {
  const sdkAny = sdk;
  const tools = [];
  const guarded = [];
  const unguardable = [];
  for (const name of input.toolNames) {
    const key = name.trim().toLowerCase();
    const factoryName = FACTORY_NAMES[key];
    if (!factoryName)
      continue;
    const factory = sdkAny[factoryName];
    if (!factory) {
      unguardable.push(name);
      continue;
    }
    const original = factory(input.cwd);
    const originalExecute = original.execute.bind(original);
    tools.push({
      ...original,
      execute: async (...args) => {
        const verdict = input.admit(name);
        if (verdict.allow)
          return originalExecute(...args);
        const refusal2 = {
          content: [{
            type: "text",
            text: `Refused: ${verdict.reason ?? `${name} is not admitted against this workspace`}`
          }],
          details: { blocked: true, tool: name }
        };
        return refusal2;
      }
    });
    guarded.push(name);
  }
  return { tools, guarded, unguardable };
}

// src/activation/ask-tool.ts
var ASK_TOOL = "ask_coordinator";
var ESCALATE_TOOL = "escalate_to_coordinator";
var toolText = (text) => ({
  content: [{ type: "text", text }],
  details: {}
});
function createAskTools(sdk, ctx) {
  const ask = async (kind, body) => {
    if (!body?.trim()) {
      return toolText("Refused: an empty question cannot be answered. State the question.");
    }
    ctx.onAsk?.(kind, body);
    const reply = await ctx.transport.request({
      kind,
      from: ctx.self,
      to: ctx.parent,
      activationId: ctx.activationId,
      attemptId: ctx.currentAttemptId(),
      body
    });
    ctx.onAnswered?.(kind);
    return toolText(reply.body);
  };
  return [
    sdk.defineTool({
      name: ASK_TOOL,
      description: "Ask the coordinator a clarifying question and WAIT for the answer. Use when the " + "task is ambiguous and guessing would produce work that has to be redone. Your " + "session stays alive while you wait and the answer is returned to you here.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question. Be specific and self-contained." }
        },
        required: ["question"]
      },
      execute: async (_toolCallId, args) => ask("question", args.question)
    }),
    sdk.defineTool({
      name: ESCALATE_TOOL,
      description: "Escalate a blocker that you cannot resolve and that the coordinator may not be " + "able to resolve either — a missing permission, a contradiction in the contract, " + "a decision that is not yours to make. You stay alive and resume when it is resolved.",
      parameters: {
        type: "object",
        properties: {
          blocker: { type: "string", description: "What is blocking you and what decision is needed." }
        },
        required: ["blocker"]
      },
      execute: async (_toolCallId, args) => ask("escalation", args.blocker)
    })
  ];
}

// src/activation/pi-sdk.ts
import { existsSync as existsSync18 } from "node:fs";
import { join as join15 } from "node:path";
import { pathToFileURL } from "node:url";
var PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";
var REQUIRED_EXPORTS = [
  "createAgentSession",
  "ModelRuntime",
  "resolveModelScopeWithDiagnostics",
  "defineTool"
];

class PiSdkUnavailableError extends Error {
  attempted;
  constructor(attempted, cause) {
    super(`Native Specialist activation requires ${PI_SDK_PACKAGE}, which could not be resolved.
` + `Tried:
${attempted.map((p) => `  • ${p}`).join(`
`)}
` + `Install pi (npm i -g ${PI_SDK_PACKAGE}) or add it as a dependency. ` + `The legacy 'sp run' path does not require it.`);
    this.attempted = attempted;
    this.name = "PiSdkUnavailableError";
    if (cause !== undefined)
      this.cause = cause;
  }
}
var cached4;
function piSdkCandidates() {
  const candidates = [PI_SDK_PACKAGE];
  const globalDir = resolveGlobalNodeModulesDir2();
  if (globalDir) {
    const entry = join15(globalDir, PI_SDK_PACKAGE, "dist", "index.js");
    if (existsSync18(entry))
      candidates.push(pathToFileURL(entry).href);
  }
  return candidates;
}
async function loadPiSdk() {
  if (cached4)
    return cached4;
  const attempted = piSdkCandidates();
  let lastError;
  for (const specifier of attempted) {
    try {
      const mod = await import(specifier);
      const missing = REQUIRED_EXPORTS.filter((name) => typeof mod[name] === "undefined");
      if (missing.length > 0) {
        lastError = new Error(`${specifier} is missing exports: ${missing.join(", ")}`);
        continue;
      }
      cached4 = mod;
      return cached4;
    } catch (error) {
      lastError = error;
    }
  }
  throw new PiSdkUnavailableError(attempted, lastError);
}

// src/activation/model-gate.ts
async function createGateModelRuntime(sdk) {
  return sdk.ModelRuntime.create({ allowModelNetwork: false });
}
async function validateModelAvailable(sdk, modelRuntime, requested) {
  let scope;
  try {
    scope = await sdk.resolveModelScopeWithDiagnostics([requested], modelRuntime);
  } catch (error) {
    return {
      ok: false,
      reason: `model resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      diagnostics: []
    };
  }
  const diagnostics = scope.diagnostics ?? [];
  const noMatch = diagnostics.find((d) => d.code === "no-match");
  if (noMatch) {
    return {
      ok: false,
      reason: noMatch.message || `no model matches "${requested}"`,
      diagnostics
    };
  }
  const first = scope.scopedModels?.[0]?.model;
  if (!first) {
    return { ok: false, reason: `no model resolved for "${requested}"`, diagnostics };
  }
  const provider = first.provider;
  if (!provider) {
    return { ok: false, reason: `resolved model for "${requested}" has no provider`, diagnostics };
  }
  const authed = await modelRuntime.hasConfiguredAuth(provider);
  if (!authed) {
    return {
      ok: false,
      reason: `provider "${provider}" has no configured auth for "${requested}"`,
      provider,
      diagnostics
    };
  }
  return {
    ok: true,
    model: first,
    resolvedModel: first.id ? `${provider}/${first.id}`.replace(`${provider}/${provider}/`, `${provider}/`) : requested,
    provider,
    diagnostics
  };
}

// src/activation/registry.ts
class FleetRegistry {
  records = new Map;
  register(record) {
    this.records.set(record.snapshot.activationId, record);
  }
  get(activationId) {
    return this.records.get(activationId);
  }
  remove(activationId) {
    this.records.delete(activationId);
  }
  list() {
    return [...this.records.values()].map((r) => r.snapshot);
  }
  projection(activationId) {
    return this.records.get(activationId)?.snapshot;
  }
}
function nextAttemptId(current) {
  const match = /^(.*):(\d+)$/.exec(current);
  if (!match)
    return `${current}:2`;
  const [, prefix, count] = match;
  return `${prefix}:${Number(count) + 1}`;
}
var RESUMABLE_STATES = new Set(["settled", "waiting", "needs_reply", "escalated"]);

// src/activation/native-host.ts
var WRITE_TIERS = new Set(["MEDIUM", "HIGH"]);
var NULL_FORENSIC_SINK = { emit: () => {} };

class NativeActivationHost {
  loader;
  beadsClient;
  forensics;
  loadSdk;
  beadGate;
  cwd;
  now;
  registry = new FleetRegistry;
  interactions;
  constructor(deps = {}) {
    this.cwd = deps.cwd ?? process.cwd();
    this.interactions = new InteractionTransport(deps.peer ? { deliver: this.wirePeerDelivery(deps.peer) } : {});
    this.loader = deps.loader ?? new SpecialistLoader({ projectDir: this.cwd });
    this.beadsClient = deps.beadsClient ?? new BeadsClient;
    this.forensics = deps.forensics ?? NULL_FORENSIC_SINK;
    this.loadSdk = deps.loadSdk ?? loadPiSdk;
    this.beadGate = deps.beadGate ?? {};
    this.now = deps.now ?? (() => Date.now());
  }
  async start(request) {
    const activationId = `act:${randomUUID3().slice(0, 12)}`;
    const attemptId = `att:${activationId.slice(4)}:1`;
    const participantId = `specialist::${request.specialist}`;
    const emit = (name, payload) => this.forensics.emit({
      activationId,
      attemptId,
      participantId,
      specialist: request.specialist,
      beadId: request.beadId,
      name,
      payload
    });
    emit("activation_requested", {
      requested_by: request.requestedByParticipantId,
      model_override: request.modelOverride ?? null
    });
    const reject = (reason, detail = {}) => {
      emit("activation_rejected", { reason, ...detail });
      throw new DispatchRejectedError(reason, {
        specialist: request.specialist,
        beadId: request.beadId,
        ...detail
      });
    };
    const specialist = await this.loader.get(request.specialist).catch((error) => {
      return reject("unknown_specialist", {
        note: error instanceof Error ? error.message : String(error)
      });
    });
    if (!specialist)
      return reject("unknown_specialist");
    const execution = specialist.specialist.execution;
    const tier = execution.permission_required ?? "READ_ONLY";
    const access = WRITE_TIERS.has(tier) ? "write" : "read";
    const bead = this.beadsClient.readBead(request.beadId);
    if (!bead)
      return reject("bead_unreadable");
    const readiness = evaluateBeadReadiness(bead, this.beadGate);
    if (!readiness.ok) {
      return reject("bead_contract_incomplete", {
        note: readiness.reason,
        ...readiness.missing.length > 0 ? { missing: readiness.missing } : {}
      });
    }
    const toolContract = resolveRuntimeToolContract({
      level: tier,
      specialistName: request.specialist,
      specialistPermissions: specialist.specialist.permissions,
      cwd: this.cwd
    });
    if (!toolContract || toolContract.toolsList.length === 0) {
      return reject("empty_tool_contract", { tier });
    }
    try {
      validateBeforeRun(specialist, tier, toolContract);
    } catch (error) {
      return reject("preflight_failed", {
        note: error instanceof Error ? error.message : String(error)
      });
    }
    const sdk = await this.loadSdk();
    const configuredModel = resolveModelChain(execution)[0];
    const requestedModel = request.modelOverride ?? configuredModel;
    if (!requestedModel)
      return reject("no_model_configured");
    const modelRuntime = await createGateModelRuntime(sdk);
    const modelCheck = await validateModelAvailable(sdk, modelRuntime, requestedModel);
    if (!modelCheck.ok) {
      return reject("model_unavailable", {
        requestedModel,
        note: modelCheck.reason
      });
    }
    const resolvedModel = modelCheck.resolvedModel ?? requestedModel;
    if (!modelCheck.model)
      return reject("model_unresolved", { requestedModel });
    const workspace = request.workspaceHint ?? {
      repositoryRoot: this.cwd,
      worktreePath: this.cwd
    };
    if (access === "write") {
      try {
        acquire({ workspace, activationId, attemptId, specialist: request.specialist });
      } catch (error) {
        if (error instanceof DispatchRejectedError) {
          emit("lease_denied", {
            workspace: workspace.worktreePath,
            reason: error.reason,
            note: error.detail.holder
          });
        }
        emit("activation_rejected", { reason: "workspace_lease_unavailable" });
        throw error;
      }
      emit("lease_acquired", { workspace: workspace.worktreePath });
    }
    const stepContract = compileStepContract({
      bead,
      specialist: specialist.specialist.metadata.name,
      responseFormat: execution.response_format,
      now: this.now
    });
    emit("step_contract_compiled", {
      root_work_ref: stepContract.rootWorkRef,
      inputs: stepContract.inputs.length,
      outputs: stepContract.outputs.length,
      non_goals: stepContract.nonGoals.length,
      constraints: stepContract.constraints?.length ?? 0,
      validation: stepContract.validation?.length ?? 0,
      source_bead_revision: stepContract.provenance.sourceBeadRevision ?? null
    });
    emit("activation_admitted", {
      tier,
      access,
      configured_model: configuredModel ?? null,
      requested_model: requestedModel,
      resolved_model: resolvedModel,
      model_override: Boolean(request.modelOverride),
      workspace: workspace.worktreePath,
      tools: toolContract.toolsList.join(","),
      custom_tools: `${ASK_TOOL},${ESCALATE_TOOL}`
    });
    const rendered = renderTaskPrompt({
      specialist: specialist.specialist,
      cwd: this.cwd,
      beadId: request.beadId,
      bead
    });
    const systemPrompt = buildSystemPrompt({
      systemPromptTemplate: specialist.specialist.prompt.system ?? "",
      templateVariables: rendered.beadTemplateVariables ?? {},
      bare: execution.bare ?? false,
      runCwd: this.cwd,
      specialistName: specialist.specialist.metadata.name,
      inputBeadId: request.beadId,
      responseFormat: execution.response_format ?? "text",
      outputType: execution.output_type ?? "custom",
      outputContractSchema: undefined,
      beadContextText: rendered.beadContextText ?? "",
      readBeadForMemory: (id) => this.beadsClient.readBead(id)
    });
    emit("activation_starting", { pi_session_id: null });
    const askTools = createAskTools(sdk, {
      transport: this.interactions,
      activationId,
      currentAttemptId: () => this.registry.get(activationId)?.snapshot.attemptId ?? attemptId,
      self: participantId,
      parent: request.requestedByParticipantId,
      onAsk: (kind, body) => {
        const record = this.registry.get(activationId);
        if (record)
          record.snapshot.state = kind === "escalation" ? "escalated" : "needs_reply";
        emit(kind === "escalation" ? "escalation_raised" : "clarification_requested", { body });
      },
      onAnswered: (kind) => {
        const record = this.registry.get(activationId);
        if (record)
          record.snapshot.state = "running";
        emit(kind === "escalation" ? "escalation_resolved" : "clarification_answered");
      }
    });
    const guardedTools = createGuardedTools(sdk, {
      toolNames: toolContract.toolsList,
      cwd: workspace.worktreePath,
      admit: (toolName) => admitToolCall({ toolName, workspace, activationId })
    });
    if (guardedTools.unguardable.length > 0) {
      emit("lease_denied", {
        workspace: workspace.worktreePath,
        note: `cannot guard mutating tools: ${guardedTools.unguardable.join(", ")}`
      });
      return reject("unguardable_mutating_tools", {
        note: `these tools mutate and cannot be fenced by the workspace lease on this runtime: ${guardedTools.unguardable.join(", ")}`
      });
    }
    const { session } = await sdk.createAgentSession({
      customTools: [...askTools, ...guardedTools.tools],
      cwd: workspace.worktreePath,
      model: modelCheck.model,
      ...execution.thinking_level ? { thinkingLevel: execution.thinking_level } : {},
      noTools: "builtin",
      tools: [...toolContract.toolsList, ASK_TOOL, ESCALATE_TOOL],
      systemPrompt: systemPrompt.text
    });
    const startedAt = this.now();
    const snapshot = {
      activationId,
      participantId,
      attemptId,
      specialist: request.specialist,
      beadId: request.beadId,
      state: "starting",
      access,
      workspace,
      piSessionId: session.sessionId,
      configuredModel,
      requestedModel,
      resolvedModel,
      modelOverride: Boolean(request.modelOverride),
      startedAt,
      lastActivityAt: startedAt
    };
    emit("activation_started", { pi_session_id: session.sessionId });
    const unsubscribe = session.subscribe((event) => this.onSessionEvent(snapshot, event, emit));
    const result = this.runToSettled(snapshot, session, rendered.initial_prompt, emit);
    this.registry.register({ snapshot, session, unsubscribe, result, stepContract });
    return {
      activationId,
      participantId,
      attemptId,
      specialist: request.specialist,
      beadId: request.beadId,
      access,
      workspace,
      resolvedModel,
      stepContract,
      result
    };
  }
  onSessionEvent(snapshot, event, emit) {
    snapshot.lastActivityAt = this.now();
    this.forensics.sessionEvent?.({
      activationId: snapshot.activationId,
      attemptId: snapshot.attemptId,
      participantId: snapshot.participantId,
      specialist: snapshot.specialist,
      beadId: snapshot.beadId,
      piSessionId: snapshot.piSessionId ?? "",
      workspacePath: snapshot.workspace.worktreePath,
      event
    });
    switch (event.type) {
      case "agent_start":
        snapshot.state = "running";
        emit("turn_started");
        break;
      case "agent_end":
        emit("turn_completed", { will_retry: Boolean(event.willRetry) });
        break;
      case "agent_settled":
        snapshot.state = "settled";
        emit("activation_settled");
        break;
      case "auto_retry_start":
        emit("retry_started", { attempt: event.attempt, max_attempts: event.maxAttempts });
        break;
      case "auto_retry_end":
        emit("retry_completed", { success: event.success, attempt: event.attempt });
        break;
      case "compaction_start":
        emit("compaction_started", { reason: event.reason });
        break;
      case "compaction_end":
        emit("compaction_completed", { reason: event.reason, aborted: event.aborted });
        break;
      default:
        break;
    }
  }
  async runToSettled(snapshot, session, initialPrompt, emit) {
    try {
      await session.prompt(initialPrompt);
      await session.waitForIdle();
      const last = lastAssistantMessage(session.messages);
      if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
        const detail = last.errorMessage ?? `turn ended with stopReason "${last.stopReason}"`;
        snapshot.state = "failed";
        emit("activation_failed", { error: detail, stop_reason: last.stopReason });
        return {
          activationId: snapshot.activationId,
          participantId: snapshot.participantId,
          attemptId: snapshot.attemptId,
          beadId: snapshot.beadId,
          status: "failed",
          output: undefined,
          validation: { valid: false, errors: [detail] },
          piSessionId: session.sessionId,
          configuredModel: snapshot.configuredModel,
          resolvedModel: snapshot.resolvedModel,
          modelOverride: snapshot.modelOverride,
          fallbackUsed: false,
          completedAt: this.now()
        };
      }
      const output = textOf(last);
      emit("output_validation_started");
      const validation = { valid: true };
      emit("output_validation_passed");
      snapshot.state = "settled";
      emit("activation_completed", { pi_session_id: session.sessionId });
      return {
        activationId: snapshot.activationId,
        participantId: snapshot.participantId,
        attemptId: snapshot.attemptId,
        beadId: snapshot.beadId,
        status: "completed",
        output,
        validation,
        piSessionId: session.sessionId,
        configuredModel: snapshot.configuredModel,
        resolvedModel: snapshot.resolvedModel,
        modelOverride: snapshot.modelOverride,
        fallbackUsed: false,
        completedAt: this.now()
      };
    } catch (error) {
      snapshot.state = "failed";
      const message = error instanceof Error ? error.message : String(error);
      emit("activation_failed", { error: message });
      return {
        activationId: snapshot.activationId,
        participantId: snapshot.participantId,
        attemptId: snapshot.attemptId,
        beadId: snapshot.beadId,
        status: "failed",
        output: undefined,
        validation: { valid: false, errors: [message] },
        piSessionId: session.sessionId,
        configuredModel: snapshot.configuredModel,
        resolvedModel: snapshot.resolvedModel,
        modelOverride: snapshot.modelOverride,
        fallbackUsed: false,
        completedAt: this.now()
      };
    }
  }
  async answer(messageId, body) {
    const ask = this.interactions.pendingAsks().find((a) => a.message.messageId === messageId);
    if (!ask)
      return;
    return this.interactions.send({
      kind: "reply",
      from: ask.message.to,
      to: ask.message.from,
      activationId: ask.message.activationId,
      attemptId: ask.message.attemptId,
      body,
      inReplyTo: messageId
    });
  }
  releaseIfWriter(snapshot, reason) {
    if (snapshot.access !== "write")
      return;
    try {
      release(snapshot.workspace, snapshot.activationId);
      this.forensics.emit({
        activationId: snapshot.activationId,
        attemptId: snapshot.attemptId,
        participantId: snapshot.participantId,
        specialist: snapshot.specialist,
        beadId: snapshot.beadId,
        name: "lease_released",
        payload: { workspace: snapshot.workspace.worktreePath, reason }
      });
    } catch (error) {
      this.forensics.emit({
        activationId: snapshot.activationId,
        attemptId: snapshot.attemptId,
        participantId: snapshot.participantId,
        specialist: snapshot.specialist,
        beadId: snapshot.beadId,
        name: "lease_uncertain",
        payload: {
          workspace: snapshot.workspace.worktreePath,
          note: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
  admitToolCall(activationId, toolName) {
    const record = this.registry.get(activationId);
    if (!record)
      return { allow: false, reason: `unknown activation ${activationId}` };
    const verdict = admitToolCall({
      toolName,
      workspace: record.snapshot.workspace,
      activationId
    });
    if (!verdict.allow) {
      this.forensics.emit({
        activationId,
        attemptId: record.snapshot.attemptId,
        participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist,
        beadId: record.snapshot.beadId,
        name: "tool_blocked",
        payload: { tool: toolName, note: verdict.reason }
      });
    }
    return verdict;
  }
  pendingAsks() {
    return this.interactions.pendingAsks();
  }
  inspect(activationId) {
    return this.registry.projection(activationId);
  }
  wirePeerDelivery(peer) {
    const repoRoot = peer.repoRoot ?? this.cwd;
    return createPeerDelivery({
      transport: () => this.interactions,
      adapter: peer.adapter ?? new PeerAdapter({
        repoRoot,
        emit: (event) => this.forensics.peerTransportEvent?.(event)
      }),
      repoRoot,
      coordinatorSessionId: peer.coordinatorSessionId,
      ...peer.replyTimeoutMs !== undefined ? { replyTimeoutMs: peer.replyTimeoutMs } : {},
      ...peer.pollIntervalMs !== undefined ? { pollIntervalMs: peer.pollIntervalMs } : {}
    });
  }
  list() {
    return this.registry.list();
  }
  async stop(activationId, reason = "operator request") {
    const record = this.registry.get(activationId);
    if (!record)
      return;
    record.snapshot.state = "stopping";
    try {
      await record.session.abort();
    } finally {
      record.unsubscribe();
      record.session.dispose();
      record.snapshot.state = "stopped";
      this.releaseIfWriter(record.snapshot, reason);
      this.forensics.emit({
        activationId,
        attemptId: record.snapshot.attemptId,
        participantId: record.snapshot.participantId,
        specialist: record.snapshot.specialist,
        beadId: record.snapshot.beadId,
        name: "activation_disposed",
        payload: { reason }
      });
      this.registry.remove(activationId);
    }
  }
  attach(activationId, listener) {
    const record = this.registry.get(activationId);
    if (!record)
      return;
    return { snapshot: record.snapshot, detach: record.session.subscribe(listener) };
  }
  return(attachment) {
    attachment.detach();
  }
  async resume(activationId, prompt) {
    const record = this.registry.get(activationId);
    if (!record) {
      throw new DispatchRejectedError("unknown_activation", { activationId });
    }
    if (!RESUMABLE_STATES.has(record.snapshot.state)) {
      throw new DispatchRejectedError("not_resumable", {
        activationId,
        note: `state is "${record.snapshot.state}"`
      });
    }
    const attemptId = nextAttemptId(record.snapshot.attemptId);
    record.snapshot.attemptId = attemptId;
    record.snapshot.state = "starting";
    const emit = (name, payload) => this.forensics.emit({
      activationId,
      attemptId,
      participantId: record.snapshot.participantId,
      specialist: record.snapshot.specialist,
      beadId: record.snapshot.beadId,
      name,
      payload
    });
    emit("activation_resumed", {
      requested_model: record.snapshot.requestedModel,
      resolved_model: record.snapshot.resolvedModel,
      model_override: record.snapshot.modelOverride
    });
    record.unsubscribe();
    record.unsubscribe = record.session.subscribe((event) => this.onSessionEvent(record.snapshot, event, emit));
    const result = this.runToSettled(record.snapshot, record.session, prompt, emit);
    record.result = result;
    return {
      activationId,
      participantId: record.snapshot.participantId,
      attemptId,
      specialist: record.snapshot.specialist,
      beadId: record.snapshot.beadId,
      access: record.snapshot.access,
      workspace: record.snapshot.workspace,
      resolvedModel: record.snapshot.resolvedModel,
      stepContract: record.stepContract,
      result
    };
  }
}
function lastAssistantMessage(messages) {
  for (let i = messages.length - 1;i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant")
      return message;
  }
  return;
}
function textOf(message) {
  const content = message?.content;
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.filter((part) => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}
// src/tools/specialist/activation.tool.ts
function toActivationView(snapshot) {
  return {
    activation_id: snapshot.activationId,
    participant_id: snapshot.participantId,
    attempt_id: snapshot.attemptId,
    specialist: snapshot.specialist,
    bead_id: snapshot.beadId,
    state: snapshot.state,
    access: snapshot.access,
    worktree_path: snapshot.workspace.worktreePath,
    ...snapshot.workspace.branch ? { branch: snapshot.workspace.branch } : {},
    ...snapshot.piSessionId ? { pi_session_id: snapshot.piSessionId } : {},
    ...snapshot.requestedModel ? { requested_model: snapshot.requestedModel } : {},
    resolved_model: snapshot.resolvedModel,
    model_override: snapshot.modelOverride
  };
}
function toPendingAskView(ask) {
  return {
    message_id: ask.message.messageId,
    kind: ask.message.kind,
    activation_id: ask.message.activationId,
    attempt_id: ask.message.attemptId,
    from: ask.message.from,
    to: ask.message.to,
    body: ask.message.body,
    delivery: ask.delivery,
    asked_at: ask.askedAt
  };
}
var specialistDispatchSchema = objectType({
  specialist: stringType().describe("Specialist name, e.g. codebase-explorer"),
  bead_id: stringType().describe("The Bead that is this activation's task contract. `--bead` is the prompt: there is no free-form task field, because supplementing an incomplete Bead through delegation prose is how durable work loses its scope."),
  model_override: stringType().optional().describe("Override the configured model for THIS activation only. An unavailable model is refused before the session is created, never silently replaced."),
  requested_by: stringType().optional().describe("ParticipantId of the requesting coordinator. Defaults to the MCP gateway participant."),
  coordinator_session_id: stringType().optional().describe("MCP session id, for lineage.")
});
var specialistReplySchema = objectType({
  message_id: stringType().describe('The message_id of the outstanding ask, from specialist_status.pending_asks. Correlation is by message id and nothing else — there is no "answer the latest ask", because with two asks outstanding that is a coin flip.'),
  body: stringType().describe("The answer. Returned to the Specialist as its tool result.")
});
var specialistStopSchema = objectType({
  activation_id: stringType().describe("Activation to stop and dispose."),
  reason: stringType().optional().describe("Recorded forensically with the disposal.")
});
// src/specialist/launch-outcome.ts
var LAUNCH_OUTCOME_SCHEMA_VERSION = "xtrm.command-outcome.v1";

class LaunchOutcomeError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "LaunchOutcomeError";
  }
}
var CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
var REASON_CODE_RE = /^[a-z][a-z0-9_]*$/;
var TOKEN_RE = /^[a-z][a-z0-9-]*$/;
var DOTTED_TOKEN_RE = /^[a-z][a-z0-9.-]*$/;
var TMUX_SESSION_ID_RE = /^\$[0-9]+$/;
var PANE_ID_RE = /^%[0-9]+$/;
var STATUSES = ["ok", "degraded", "noop", "rejected", "failed"];
var RUNTIMES = ["pi", "claude", "codex"];
var READINESS_STATUSES = ["ready", "unverified", "not_ready"];
var READINESS_SOURCES = ["agent.ready", "tmux-pane", "none"];
var ACTION_KINDS = ["attach", "resume", "repair", "end", "wait", "inspect"];
var SIDE_EFFECT_STATUSES = ["ok", "degraded", "failed", "skipped"];
function fail(code, message) {
  throw new LaunchOutcomeError(code, message);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value, field, maxLength, allowEmpty = false) {
  if (typeof value !== "string")
    fail("invalid_outcome", `${field} must be a string`);
  if (value.length === 0 && !allowEmpty)
    fail("invalid_outcome", `${field} must be non-empty`);
  if (value.length > maxLength)
    fail("invalid_outcome", `${field} exceeds ${maxLength} characters`);
  if (CONTROL_CHARS.test(value))
    fail("invalid_outcome", `${field} contains control characters`);
  return value;
}
function patternString(value, field, maxLength, pattern) {
  const s = boundedString(value, field, maxLength);
  if (!pattern.test(s))
    fail("invalid_outcome", `${field} does not match the contracted pattern`);
  return s;
}
function nullablePatternString(value, field, maxLength, pattern) {
  if (value === null || value === undefined)
    return null;
  return patternString(value, field, maxLength, pattern);
}
function enumValue(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail("invalid_outcome", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}
function mutationRecord(value, field) {
  if (!isObject(value))
    fail("invalid_outcome", `${field} must be an object`);
  if (typeof value.completed !== "boolean")
    fail("invalid_outcome", `${field}.completed must be a boolean`);
  return { completed: value.completed, kind: patternString(value.kind, `${field}.kind`, 96, DOTTED_TOKEN_RE) };
}
function parseLaunchOutcome(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail("invalid_json", `outcome is not valid JSON: ${error?.message ?? String(error)}`);
  }
}
function validateLaunchOutcome(value) {
  if (!isObject(value))
    fail("invalid_outcome", "outcome must be a JSON object");
  const schemaVersion = value.schema_version;
  if (typeof schemaVersion !== "string" || schemaVersion.length === 0) {
    fail("unsupported_schema", "outcome is missing schema_version");
  }
  if (schemaVersion !== LAUNCH_OUTCOME_SCHEMA_VERSION) {
    fail("unsupported_schema", `unsupported schema_version '${schemaVersion}' (this consumer accepts '${LAUNCH_OUTCOME_SCHEMA_VERSION}')`);
  }
  const outcome = {
    schema_version: schemaVersion,
    status: enumValue(value.status, "status", STATUSES),
    reason_code: patternString(value.reason_code, "reason_code", 64, REASON_CODE_RE),
    summary: boundedString(value.summary, "summary", 240),
    runtime: null,
    identity: null,
    worktree: null,
    readiness: null,
    safety_profile: null,
    persistence: null,
    authoritative_mutation: mutationRecord(value.authoritative_mutation, "authoritative_mutation"),
    side_effects: [],
    next_actions: []
  };
  if (value.runtime !== undefined) {
    if (!isObject(value.runtime))
      fail("invalid_outcome", "runtime must be an object");
    if (!("version" in value.runtime))
      fail("invalid_outcome", "runtime.version is required when runtime is present");
    outcome.runtime = {
      name: enumValue(value.runtime.name, "runtime.name", RUNTIMES),
      version: value.runtime.version === null ? null : boundedString(value.runtime.version, "runtime.version", 128)
    };
  }
  if (value.identity !== undefined) {
    if (!isObject(value.identity))
      fail("invalid_outcome", "identity must be an object");
    const identity2 = value.identity;
    for (const key of ["thread_id", "session_name", "tmux_session_id", "pane_id"]) {
      if (!(key in identity2))
        fail("invalid_outcome", `identity.${key} is required when identity is present`);
    }
    const nullableId = (field) => {
      const v = identity2[field];
      if (v === null)
        return null;
      return boundedString(v, `identity.${field}`, 256);
    };
    outcome.identity = {
      thread_id: nullableId("thread_id"),
      session_name: nullableId("session_name"),
      tmux_session_id: nullablePatternString(identity2.tmux_session_id, "identity.tmux_session_id", 32, TMUX_SESSION_ID_RE),
      pane_id: nullablePatternString(identity2.pane_id, "identity.pane_id", 32, PANE_ID_RE)
    };
  }
  if (value.worktree !== undefined) {
    if (!isObject(value.worktree))
      fail("invalid_outcome", "worktree must be an object");
    if (value.worktree.owner !== "core")
      fail("invalid_outcome", "worktree.owner must be 'core' (Core owns launcher worktrees)");
    outcome.worktree = {
      path: boundedString(value.worktree.path, "worktree.path", 4096),
      branch: boundedString(value.worktree.branch, "worktree.branch", 4096),
      owner: "core"
    };
  }
  if (value.readiness !== undefined) {
    if (!isObject(value.readiness))
      fail("invalid_outcome", "readiness must be an object");
    outcome.readiness = {
      status: enumValue(value.readiness.status, "readiness.status", READINESS_STATUSES),
      source: enumValue(value.readiness.source, "readiness.source", READINESS_SOURCES)
    };
  }
  if (value.safety_profile !== undefined) {
    if (!isObject(value.safety_profile))
      fail("invalid_outcome", "safety_profile must be an object");
    if (value.safety_profile.hook_trust !== "preserved") {
      fail("invalid_outcome", "safety_profile.hook_trust must be 'preserved'");
    }
    outcome.safety_profile = {
      name: patternString(value.safety_profile.name, "safety_profile.name", 64, TOKEN_RE),
      sandbox: patternString(value.safety_profile.sandbox, "safety_profile.sandbox", 64, TOKEN_RE),
      approvals: patternString(value.safety_profile.approvals, "safety_profile.approvals", 64, TOKEN_RE),
      hook_trust: "preserved"
    };
  }
  if (value.persistence !== undefined) {
    outcome.persistence = mutationRecord(value.persistence, "persistence");
  }
  if (!Array.isArray(value.side_effects))
    fail("invalid_outcome", "side_effects must be an array");
  if (value.side_effects.length > 32)
    fail("invalid_outcome", "side_effects exceeds 32 entries");
  for (const [index, effect] of value.side_effects.entries()) {
    if (!isObject(effect))
      fail("invalid_outcome", `side_effects[${index}] must be an object`);
    const entry = {
      kind: patternString(effect.kind, `side_effects[${index}].kind`, 96, DOTTED_TOKEN_RE),
      status: enumValue(effect.status, `side_effects[${index}].status`, SIDE_EFFECT_STATUSES)
    };
    if (effect.id !== undefined)
      entry.id = effect.id === null ? null : boundedString(effect.id, `side_effects[${index}].id`, 256);
    outcome.side_effects.push(entry);
  }
  if (!Array.isArray(value.next_actions))
    fail("invalid_outcome", "next_actions must be an array");
  if (value.next_actions.length > 16)
    fail("invalid_outcome", "next_actions exceeds 16 entries");
  for (const [index, action] of value.next_actions.entries()) {
    if (!isObject(action))
      fail("invalid_outcome", `next_actions[${index}] must be an object`);
    if (!Array.isArray(action.argv) || action.argv.length === 0) {
      fail("invalid_outcome", `next_actions[${index}].argv must be a non-empty array`);
    }
    if (action.argv.length > 32)
      fail("invalid_outcome", `next_actions[${index}].argv exceeds 32 entries`);
    if (typeof action.required !== "boolean")
      fail("invalid_outcome", `next_actions[${index}].required must be a boolean`);
    const entry = {
      kind: enumValue(action.kind, `next_actions[${index}].kind`, ACTION_KINDS),
      required: action.required,
      argv: action.argv.map((arg, argIndex) => boundedString(arg, `next_actions[${index}].argv[${argIndex}]`, 4096, true)),
      display: boundedString(action.display, `next_actions[${index}].display`, 8192),
      why: boundedString(action.why, `next_actions[${index}].why`, 240)
    };
    if (action.cwd !== undefined)
      entry.cwd = boundedString(action.cwd, `next_actions[${index}].cwd`, 4096);
    outcome.next_actions.push(entry);
  }
  return outcome;
}
function projectLaunchOutcome(outcome) {
  return {
    schema_version: outcome.schema_version,
    status: outcome.status,
    reason_code: outcome.reason_code,
    summary: outcome.summary,
    runtime: outcome.runtime ? { name: outcome.runtime.name, version: outcome.runtime.version } : null,
    identity: outcome.identity ? {
      thread_id: outcome.identity.thread_id,
      session_name: outcome.identity.session_name,
      tmux_session_id: outcome.identity.tmux_session_id,
      pane_id: outcome.identity.pane_id
    } : null,
    worktree: outcome.worktree ? { path: outcome.worktree.path, branch: outcome.worktree.branch, owner: outcome.worktree.owner } : null,
    readiness: outcome.readiness ? { status: outcome.readiness.status, source: outcome.readiness.source } : null,
    safety_profile: outcome.safety_profile ? {
      name: outcome.safety_profile.name,
      sandbox: outcome.safety_profile.sandbox,
      approvals: outcome.safety_profile.approvals,
      hook_trust: outcome.safety_profile.hook_trust
    } : null,
    persistence: outcome.persistence ? { completed: outcome.persistence.completed, kind: outcome.persistence.kind } : null,
    authoritative_mutation: {
      completed: outcome.authoritative_mutation.completed,
      kind: outcome.authoritative_mutation.kind
    },
    side_effects: outcome.side_effects.map((effect) => ({
      kind: effect.kind,
      status: effect.status,
      ...effect.id !== undefined ? { id: effect.id } : {}
    })),
    next_actions: outcome.next_actions.map((action) => ({
      kind: action.kind,
      required: action.required,
      argv: [...action.argv],
      display: action.display,
      why: action.why,
      ...action.cwd !== undefined ? { cwd: action.cwd } : {}
    }))
  };
}
// src/specialist/citation-evidence.ts
import { realpath, readFile as readFile2 } from "node:fs/promises";
import { isAbsolute as isAbsolute4, relative as relative3, resolve as resolve10 } from "node:path";
function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}
async function safeCitationPath(path, trustedRoot = process.cwd()) {
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new TypeError("path must not contain control characters");
  }
  if (isAbsolute4(path)) {
    throw new TypeError("path must be relative to trusted root");
  }
  if (path.split(/[\\/]/u).includes("..")) {
    throw new TypeError("path must remain within trusted root");
  }
  const canonicalRoot = await realpath(trustedRoot);
  const canonicalPath = await realpath(resolve10(canonicalRoot, path));
  const pathFromRoot = relative3(canonicalRoot, canonicalPath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${resolve10("/").slice(0, 1)}`) || isAbsolute4(pathFromRoot)) {
    throw new TypeError("path must remain within trusted root");
  }
  return canonicalPath;
}
async function readVerifiedCitationWindow(path, options = {}) {
  const resolvedPath = await safeCitationPath(path, options.trustedRoot);
  const offset = positiveInteger(options.offset, 1, "offset");
  const limit = options.limit === undefined ? undefined : positiveInteger(options.limit, 1, "limit");
  const maxLines = positiveInteger(options.maxLines, 2000, "maxLines");
  const maxBytes = positiveInteger(options.maxBytes, 50 * 1024, "maxBytes");
  const content = await readFile2(resolvedPath, "utf8");
  const sourceLines = content.split(`
`);
  const totalLines = sourceLines.length;
  const start = offset - 1;
  if (start >= totalLines) {
    throw new RangeError(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
  }
  const requestedEnd = limit === undefined ? totalLines : Math.min(start + limit, totalLines);
  const requestedLines = sourceLines.slice(start, requestedEnd);
  const lines = [];
  let bytes = 0;
  for (const [index, text] of requestedLines.entries()) {
    if (lines.length >= maxLines)
      break;
    const separatorBytes = lines.length === 0 ? 0 : 1;
    const candidateBytes = bytes + separatorBytes + Buffer.byteLength(text, "utf8");
    if (candidateBytes > maxBytes)
      break;
    bytes = candidateBytes;
    lines.push({ line: offset + index, text });
  }
  if (requestedLines.length > 0 && lines.length === 0) {
    throw new RangeError(`Line ${offset} exceeds the ${maxBytes}-byte verification limit`);
  }
  const truncated = lines.length < requestedLines.length;
  const consumedThrough = start + lines.length;
  const complete = consumedThrough >= totalLines;
  return {
    source: "deterministic_file_read",
    path,
    trustedRoot: options.trustedRoot ?? process.cwd(),
    offset,
    totalLines,
    lines,
    complete,
    truncated,
    ...complete ? {} : { nextOffset: consumedThrough + 1 }
  };
}
async function verifyExactLineCitation(evidence, claim) {
  if (evidence.source === "raw_pi_read") {
    return { ok: false, reason: "raw_pi_read_unverified" };
  }
  const verifiedLine = evidence.lines.find((entry) => entry.line === claim.line);
  if (!verifiedLine) {
    return { ok: false, reason: "line_outside_verified_window" };
  }
  if (verifiedLine.text !== claim.text) {
    return { ok: false, reason: "line_mismatch" };
  }
  const currentContent = await readFile2(await safeCitationPath(evidence.path, evidence.trustedRoot), "utf8");
  const currentLine = currentContent.split(`
`)[claim.line - 1];
  if (currentLine !== claim.text) {
    return { ok: false, reason: "stale_snapshot" };
  }
  return {
    ok: true,
    citation: `${evidence.path}:${claim.line}`,
    line: claim.line,
    text: claim.text
  };
}
export {
  verifyExactLineCitation,
  validateLaunchOutcome,
  toPendingAskView,
  toActivationView,
  runScriptSpecialist as runScript,
  readVerifiedCitationWindow,
  projectLaunchOutcome,
  parseLaunchOutcome,
  SpecialistLoader,
  NativeActivationHost,
  LaunchOutcomeError,
  LAUNCH_OUTCOME_SCHEMA_VERSION,
  DispatchRejectedError
};
