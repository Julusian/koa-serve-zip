/**
 * Module dependencies.
 */

const debug = require('debug')('koa-send')
const createError = require('http-errors')
const assert = require('assert')
const { npath } = require("@yarnpkg/fslib");

async function exists (zipFs, path) {
  try {
    await zipFs.accessPromise(path)
    return true
  } catch (e) {
    return false
  }
}

const {
  basename,
  extname,
  parse,
  sep
} = require('path')

/**
 * Expose `send()`.
 */

module.exports = send

/**
 * Send file at `path` with the
 * given `options` to the koa `ctx`.
 *
 * @param {Context} ctx
 * @param {String} path
 * @param {Object} [opts]
 * @return {Promise}
 * @api public
 */

async function send (ctx, path, opts = {}) {
  assert(ctx, 'koa context required')
  assert(path, 'pathname required')

  const zipFs = opts.fs;
  if (!zipFs) {
    throw new TypeError("fs implemtation must be provided");
  }

  // options
  debug('send "%s" %j', path, opts)
  const trailingSlash = path[path.length - 1] === '/'
  path = path.substr(parse(path).root.length)
  const index = opts.index
  const maxage = opts.maxage || opts.maxAge || 0
  const immutable = opts.immutable || false
  const hidden = opts.hidden || false
  const format = opts.format !== false
  const extensions = Array.isArray(opts.extensions) ? opts.extensions : false
  const brotli = opts.brotli !== false
  const gzip = opts.gzip !== false
  const setHeaders = opts.setHeaders

  if (setHeaders && typeof setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function')
  }

  // normalize path
  path = decode(path)

  if (path === -1) return ctx.throw(400, 'failed to decode')

  // index file support
  if (index && trailingSlash) path += index

  path = zipFs.resolve(path)


  // hidden file support, ignore
  if (!hidden && isHidden(path)) return

  let encodingExt = ''
  // serve brotli file when possible otherwise gzipped file when possible
  if (ctx.acceptsEncodings('br', 'identity') === 'br' && brotli && (await exists(zipFs, path + '.br'))) {
    path = path + '.br'
    ctx.set('Content-Encoding', 'br')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.br'
  } else if (ctx.acceptsEncodings('gzip', 'identity') === 'gzip' && gzip && (await exists(zipFs, path + '.gz'))) {
    path = path + '.gz'
    ctx.set('Content-Encoding', 'gzip')
    ctx.res.removeHeader('Content-Length')
    encodingExt = '.gz'
  }

  if (extensions && !/\./.exec(basename(path))) {
    const list = [].concat(extensions)
    for (let i = 0; i < list.length; i++) {
      let ext = list[i]
      if (typeof ext !== 'string') {
        throw new TypeError('option extensions must be array of strings or false')
      }
      if (!/^\./.exec(ext)) ext = `.${ext}`
      if (await exists(zipFs, `${path}${ext}`)) {
        path = `${path}${ext}`
        break
      }
    }
  }

  // stat
  let stats
  try {
    stats = await zipFs.statPromise(npath.toPortablePath(path))

    // Format the path to serve static file servers
    // and not require a trailing slash for directories,
    // so that you can do both `/directory` and `/directory/`
    if (stats.isDirectory()) {
      if (format && index) {
        path += `/${index}`
        stats = await zipFs.statPromise(npath.toPortablePath(path))
      } else {
        return
      }
    }
  } catch (err) {
    const notfound = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR']
    if (notfound.includes(err.code)) {
      throw createError(404, err)
    }
    err.status = 500
    throw err
  }

  if (setHeaders) setHeaders(ctx.res, path, stats)

  // stream
  ctx.set('Content-Length', stats.size)
  if (!ctx.response.get('Last-Modified')) ctx.set('Last-Modified', stats.mtime.toUTCString())
  if (!ctx.response.get('Cache-Control')) {
    const directives = [`max-age=${(maxage / 1000 | 0)}`]
    if (immutable) {
      directives.push('immutable')
    }
    ctx.set('Cache-Control', directives.join(','))
  }
  if (!ctx.type) ctx.type = type(path, encodingExt)
  ctx.body = zipFs.createReadStream(npath.toPortablePath(path))

  return path
}

/**
 * Check if it's hidden.
 */

function isHidden (path) {
  path = path.split(sep)
  for (let i = 0; i < path.length; i++) {
    if (path[i][0] === '.') return true
  }
  return false
}

/**
 * File type.
 */

function type (file, ext) {
  return ext !== '' ? extname(basename(file, ext)) : extname(file)
}

/**
 * Decode `path`.
 */

function decode (path) {
  try {
    return decodeURIComponent(path)
  } catch (err) {
    return -1
  }
}
