import * as JWT from './utils/jwt.js'
import { JSONResponse, notFound } from './utils/json-response.js'
import { JWT_ISSUER } from './constants.js'
import { HTTPError, RangeNotSatisfiableError } from './errors.js'
import { getTagValue, hasPendingTagProposal, hasTag } from './utils/tags.js'
import {
  NO_READ_OR_WRITE,
  READ_WRITE,
  READ_ONLY,
  maintenanceHandler
} from './maintenance.js'
import { pagination } from './utils/pagination.js'
import { toPinStatusResponse } from './pins.js'
import { validateSearchParams } from './utils/psa.js'
import { magicLinkBypassForE2ETestingInTestmode } from './magic.link.js'
import { getPaymentSettings, savePaymentSettings } from './utils/billing.js'

/**
 * @typedef {{ _id: string, issuer: string }} User
 * @typedef {{ _id: string, name: string }} AuthToken
 * @typedef {{ user: User, authToken?: AuthToken }} Auth
 * @typedef {Request & { auth: Auth }} AuthenticatedRequest
 * @typedef {import('@web3-storage/db').PageRequest} PageRequest
 */

/**
 * @param {Request} request
 * @param {import('./env').Env} env
 * @returns {Promise<Response>}
 */
export async function userLoginPost (request, env) {
  const user = await loginOrRegister(request, env)
  return new JSONResponse({ issuer: user.issuer })
}

/**
 * Controller for logging in using a magic.link token
 */
function createMagicLoginController (env, testModeBypass = magicLinkBypassForE2ETestingInTestmode) {
  const createTestmodeMetadata = (token) => {
    const { issuer } = testModeBypass.authenticateMagicToken(env, token)
    return {
      issuer,
      email: 'testMode@magic.link',
      publicAddress: issuer
    }
  }
  /**
   * authenticate an incoming request that has a magic.link token.
   * throws error if token isnt valid
   * @returns {Promise} metadata about the validated token
   */
  const authenticate = async ({ token }) => {
    if (testModeBypass.isEnabledForToken(env, token)) {
      return createTestmodeMetadata(token)
    }
    await env.magic.token.validate(token)
    return env.magic.users.getMetadataByToken(token)
  }
  return {
    authenticate
  }
}

/**
 * @param {Request} request
 * @param {import('./env').Env} env
 */
async function loginOrRegister (request, env) {
  const data = await request.json()
  const auth = request.headers.get('Authorization') || ''

  const token = env.magic.utils.parseAuthorizationHeader(auth)
  const metadata = await (createMagicLoginController(env).authenticate({ token }))
  const { issuer, email, publicAddress } = metadata
  if (!issuer || !email || !publicAddress) {
    throw new Error('missing required metadata')
  }

  const parsed =
    data.type === 'github'
      ? parseGitHub(data.data, metadata)
      : parseMagic(metadata)

  let user
  // check if maintenance mode
  if (env.MODE === NO_READ_OR_WRITE) {
    return maintenanceHandler()
  } else if (env.MODE === READ_WRITE) {
    // @ts-ignore
    user = await env.db.upsertUser(parsed)
  } else if (env.MODE === READ_ONLY) {
    user = await env.db.getUser(parsed.issuer, {})
  } else {
    throw new Error('Unknown maintenance mode')
  }

  return user
}

/**
 * @param {import('@magic-ext/oauth').OAuthRedirectResult} data
 * @param {import('@magic-sdk/admin').MagicUserMetadata} magicMetadata
 * @returns {User}
 */
function parseGitHub ({ oauth }, { issuer, email, publicAddress }) {
  return {
    // @ts-ignore
    name: oauth.userInfo.name || '',
    picture: oauth.userInfo.picture || '',
    issuer: issuer ?? '',
    email,
    github: oauth.userHandle,
    publicAddress
  }
}

/**
 * @param {import('@magic-sdk/admin').MagicUserMetadata & { email: string, issuer: string }} magicMetadata
 */
function parseMagic ({ issuer, email, publicAddress }) {
  const name = email.split('@')[0]
  return {
    name,
    picture: '',
    issuer,
    email,
    publicAddress
  }
}

/**
 * Create a new auth key.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 * @returns {Promise<Response>}
 */
export async function userTokensPost (request, env) {
  const { name } = await request.json()
  if (!name || typeof name !== 'string') {
    throw Object.assign(new Error('invalid name'), { status: 400 })
  }

  const { _id, issuer } = request.auth.user
  const sub = issuer
  const iss = JWT_ISSUER
  const secret = await JWT.sign({ sub, iss, iat: Date.now(), name }, env.SALT)

  const key = await env.db.createKey({
    // @ts-ignore
    user: _id,
    name,
    secret
  })

  return new JSONResponse(key, { status: 201 })
}

/**
 * Retrieve user account data.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userAccountGet (request, env) {
  const [usedStorage, storageLimitBytes] = await Promise.all([
    // @ts-ignore
    env.db.getStorageUsed(request.auth.user._id),
    // @ts-ignore
    env.db.getUserTagValue(request.auth.user._id, 'StorageLimitBytes')
  ])
  return new JSONResponse({
    usedStorage,
    storageLimitBytes
  })
}

/**
 * Retrieve user info
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userInfoGet (request, env) {
  const user = await env.db.getUser(request.auth.user.issuer, {
    includeTags: true,
    // @ts-ignore
    includeTagProposals: true
  })

  return new JSONResponse({
    info: {
      ...user,
      tags: {
        HasAccountRestriction: hasTag(user, 'HasAccountRestriction', 'true'),
        HasDeleteRestriction: hasTag(user, 'HasDeleteRestriction', 'true'),
        HasPsaAccess: hasTag(user, 'HasPsaAccess', 'true'),
        HasSuperHotAccess: hasTag(user, 'HasSuperHotAccess', 'true'),
        StorageLimitBytes: getTagValue(user, 'StorageLimitBytes', '')
      },
      tagProposals: {
        HasAccountRestriction: hasPendingTagProposal(user, 'HasAccountRestriction'),
        HasDeleteRestriction: hasPendingTagProposal(user, 'HasDeleteRestriction'),
        HasPsaAccess: hasPendingTagProposal(user, 'HasPsaAccess'),
        HasSuperHotAccess: hasPendingTagProposal(user, 'HasSuperHotAccess'),
        StorageLimitBytes: hasPendingTagProposal(user, 'StorageLimitBytes')
      }
    }
  })
}

/**
 * Post a new user request.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userRequestPost (request, env) {
  const user = request.auth.user
  const { tagName, requestedTagValue, userProposalForm } = await request.json()
  // @ts-ignore
  const res = await env.db.createUserRequest(
    user._id,
    tagName,
    requestedTagValue,
    userProposalForm
  )

  try {
    notifySlack(user, tagName, requestedTagValue, userProposalForm, env)
  } catch (e) {
    console.error('Failed to notify Slack: ', e)
  }

  return new JSONResponse(res)
}

/**
 * Retrieve user auth tokens.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userTokensGet (request, env) {
  // @ts-ignore
  const tokens = await env.db.listKeys(request.auth.user._id)

  return new JSONResponse(tokens)
}

/**
 * Delete a user auth token. This actually raises a tombstone rather than
 * deleting it entirely.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userTokensDelete (request, env) {
  // @ts-ignore
  const res = await env.db.deleteKey(request.auth.user._id, request.params.id)
  return new JSONResponse(res)
}

/**
 * Retrieve a page of user uploads.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userUploadsGet (request, env) {
  const requestUrl = new URL(request.url)
  const { searchParams } = requestUrl

  const pageRequest = pagination(searchParams)

  let data
  try {
    // @ts-ignore
    data = await env.db.listUploads(request.auth.user._id, pageRequest)
  } catch (err) {
    // @ts-ignore
    if (err.code === 'RANGE_NOT_SATISFIABLE_ERROR_DB') {
      throw new RangeNotSatisfiableError()
    }
    throw err
  }

  const headers = { Count: data.count }

  if (pageRequest.size != null) {
    headers.Size = pageRequest.size // Deprecated, use Link header instead.
  }

  // @ts-ignore
  if (pageRequest.page != null) {
    // @ts-ignore
    headers.Page = pageRequest.page // Deprecated, use Link header instead.
  }

  const link = getLinkHeader({
    url: requestUrl.pathname,
    pageRequest,
    items: data.uploads,
    count: data.count
  })

  if (link) {
    headers.Link = link
  }

  // @ts-ignore
  return new JSONResponse(data.uploads, { headers })
}

/**
 * Generates a HTTP `Link` header for the given page request and data.
 *
 * @param {Object} args
 * @param {string|URL} args.url Base URL
 * @param {PageRequest} args.pageRequest Details for the current page of data
 * @param {Array<{ created: string }>} args.items Page items
 * @param {number} args.count Total items available
 */
function getLinkHeader ({ url, pageRequest, items, count }) {
  const rels = []

  if ('before' in pageRequest) {
    const { size } = pageRequest
    if (items.length === size) {
      const oldest = items[items.length - 1]
      // @ts-ignore
      const nextParams = new URLSearchParams({ size, before: oldest.created })
      rels.push(`<${url}?${nextParams}>; rel="next"`)
    }
  } else if ('page' in pageRequest) {
    const { size, page } = pageRequest
    // @ts-ignore
    const pages = Math.ceil(count / size)
    if (page < pages) {
      // @ts-ignore
      const nextParams = new URLSearchParams({ size, page: page + 1 })
      rels.push(`<${url}?${nextParams}>; rel="next"`)
    }

    // @ts-ignore
    const lastParams = new URLSearchParams({ size, page: pages })
    rels.push(`<${url}?${lastParams}>; rel="last"`)

    // @ts-ignore
    const firstParams = new URLSearchParams({ size, page: 1 })
    rels.push(`<${url}?${firstParams}>; rel="first"`)

    if (page > 1) {
      // @ts-ignore
      const prevParams = new URLSearchParams({ size, page: page - 1 })
      rels.push(`<${url}?${prevParams}>; rel="previous"`)
    }
  } else {
    throw new Error('unknown page request type')
  }

  return rels.join(', ')
}

/**
 * Retrieve a single user upload.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userUploadGet (request, env) {
  // @ts-ignore
  const cid = request.params.cid
  let res
  try {
    // @ts-ignore
    res = await env.db.getUpload(cid, request.auth.user._id)
  } catch (error) {
    return notFound()
  }

  return new JSONResponse(res)
}

/**
 * Delete an user upload. This actually raises a tombstone rather than
 * deleting it entirely.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userUploadsDelete (request, env) {
  // @ts-ignore
  const cid = request.params.cid
  const user = request.auth.user._id

  // @ts-ignore
  const res = await env.db.deleteUpload(user, cid)
  if (res) {
    return new JSONResponse(res)
  }

  throw new HTTPError('Upload not found', 404)
}

/**
 * Renames a user's upload.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userUploadsRename (request, env) {
  const user = request.auth.user._id
  // @ts-ignore
  const { cid } = request.params
  const { name } = await request.json()

  // @ts-ignore
  const res = await env.db.renameUpload(user, cid, name)
  return new JSONResponse(res)
}

/**
 * List a user's pins regardless of the token used.
 * As we don't want to scope the Pinning Service API to users
 * we need a new endpoint as an umbrella.
 *
 * @param {AuthenticatedRequest} request
 * @param {import('./env').Env} env
 */
export async function userPinsGet (request, env) {
  const requestUrl = new URL(request.url)
  const { searchParams } = requestUrl

  const pageRequest = pagination(searchParams)
  const urlParams = new URLSearchParams(requestUrl.search)
  const params = Object.fromEntries(urlParams)

  const psaParams = validateSearchParams(params)
  if (psaParams.error) {
    throw psaParams.error
  }

  // @ts-ignore
  const tokens = (await env.db.listKeys(request.auth.user._id)).map((key) => key._id)

  let pinRequests

  try {
    // @ts-ignore
    pinRequests = await env.db.listPsaPinRequests(tokens, {
      ...psaParams.data,
      limit: pageRequest.size,
      // @ts-ignore
      offset: pageRequest.size * (pageRequest.page - 1)
    })
  } catch (err) {
    // @ts-ignore
    if (err.code === 'RANGE_NOT_SATISFIABLE_ERROR_DB') {
      throw new RangeNotSatisfiableError()
    }
    throw err
  }

  const pins = pinRequests.results.map((pinRequest) => toPinStatusResponse(pinRequest))

  const headers = {
    Count: pinRequests.count
  }

  if (pageRequest.size != null) {
    headers.Size = pageRequest.size // Deprecated, use Link header instead.
  }

  // @ts-ignore
  if (pageRequest.page != null) {
    // @ts-ignore
    headers.Page = pageRequest.page // Deprecated, use Link header instead.
  }

  const link = getLinkHeader({
    url: requestUrl.pathname,
    pageRequest,
    items: pinRequests.results,
    count: pinRequests.count
  })

  if (link) {
    headers.Link = link
  }

  return new JSONResponse({
    count: pinRequests.count,
    results: pins
  // @ts-ignore
  }, { headers })
}

/**
 * @param {string} userProposalForm
 * @param {string} tagName
 * @param {string} requestedTagValue
 */
const notifySlack = async (
  user,
  tagName,
  requestedTagValue,
  userProposalForm,
  env
) => {
  const webhookUrl = env.SLACK_USER_REQUEST_WEBHOOK_URL

  if (!webhookUrl) {
    return
  }

  let form
  try {
    form = JSON.parse(userProposalForm)
  } catch (e) {
    console.error('Failed to parse user request form: ', e)
    return
  }

  globalThis.fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-type': 'application/json'
    },
    body: JSON.stringify({
      text: `
>*Username*
>${user.name}
>
>*Email*
>${user.email}
>
>*User Id*
>${user._id}
>
>*Requested Tag Name*
>${tagName}
>
>*Requested Tag Value*
>${tagName === 'StorageLimitBytes' && requestedTagValue === '' ? '1TiB' : requestedTagValue}
>${form
        .map(
          ({ label, value }) => `
>*${label}*
>${value}
>`
        )
        .join('')}
`
    })
  })
}

/**
 * Get a user's payment settings.
 *
 * @param {AuthenticatedRequest} request
 * @param {Pick<import('./env').Env, 'billing'|'customers'>} env
 */
export async function userPaymentGet (request, env) {
  const userPaymentSettings = await getPaymentSettings({
    billing: env.billing,
    customers: env.customers,
    user: { id: request.auth.user._id }
  })
  return new JSONResponse(userPaymentSettings)
}

/**
 * Save a user's payment settings.
 *
 * @param {AuthenticatedRequest} request
 * @param {Pick<import('./env').Env, 'billing'|'customers'>} env
 */
export async function userPaymentPut (request, env) {
  const requestBody = await request.json()
  const paymentMethodId = requestBody?.method?.id
  if (typeof paymentMethodId !== 'string') {
    throw Object.assign(new Error('Invalid payment method'), { status: 400 })
  }
  const method = { id: paymentMethodId }
  await savePaymentSettings(
    {
      billing: env.billing,
      customers: env.customers,
      user: { id: request.auth.user._id }
    },
    {
      method
    }
  )
  const userPaymentSettingsUrl = '/user/payment'
  const savePaymentSettingsResponse = {
    location: userPaymentSettingsUrl
  }
  return new JSONResponse(savePaymentSettingsResponse, {
    status: 202,
    headers: {
      location: userPaymentSettingsUrl
    }
  })
}
