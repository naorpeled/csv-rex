// chunkSize >> largest expected row
const defaultOptions = {
  header: true, // false: return array; true: detect headers and return json; [...]: use defined headers and return json
  newlineChar: '\r\n', // undefined: detect newline from file; '\r\n': Windows; '\n': Linux/Mac
  delimiterChar: ',',
  quoteChar: '"',
  // escapeChar: '"', // default: `quoteChar`

  // Parse
  emptyFieldValue: '',
  coerceField: (field) => field, // TODO tests
  commentPrefixValue: false, // falsy: disable, '//': enabled
  errorOnComment: true,
  errorOnEmptyLine: true,
  errorOnFieldsMismatch: true
  // errorOnFieldMalformed: true
}

const length = (value) => value.length
const escapeRegExp = (string) => string.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&') // https://github.com/tc39/proposal-regex-escaping

export const parse = (opts = {}) => {
  const options = { ...defaultOptions, ...opts }
  options.escapeChar ??= options.quoteChar

  let { header } = options
  let headerLength = length(header)

  const {
    newlineChar,
    delimiterChar,
    quoteChar,
    escapeChar,
    commentPrefixValue,
    emptyFieldValue,
    coerceField,
    errorOnEmptyLine,
    errorOnComment,
    errorOnFieldsMismatch
    // errorOnFieldMalformed
  } = options
  const escapedQuoteChar = escapeChar + quoteChar
  const escapedQuoteCharRegExp = new RegExp(
    `${escapeRegExp(escapedQuoteChar)}`,
    'g'
  )

  const escapedQuoteEqual = escapeChar === quoteChar
  const escapedQuoteNotEqual = escapeChar !== quoteChar

  const newlineCharLength = length(newlineChar)
  const delimiterCharLength = 1 // length(delimiterChar)
  const quoteCharLength = 1 // length(quoteChar)
  const escapeCharLength = 1 // length(escapeChar)
  const escapedQuoteCharLength = 2 // length(escapedQuoteChar)
  // const commentPrefixValueLength = length(commentPrefixValue)

  let chunk, chunkLength, cursor, row, enqueue
  let partialLine = ''
  let idx = 0
  const enqueueRow = (row) => {
    idx += 1
    if (header === true) {
      header = row
      headerLength = length(header)
      return
    }
    let data = row
    if (headerLength) {
      const rowLength = length(row)

      if (headerLength !== rowLength) {
        if (errorOnFieldsMismatch) {
          // enqueueError('FieldsMismatch', `Parsed ${rowLength} fields, expected ${headerLength}.`)
          if (headerLength < rowLength) {
            enqueueError(
              'FieldsMismatchTooMany',
              `Too many fields were parsed, ${rowLength}, expected ${headerLength}.`
            )
          } else if (rowLength < headerLength) {
            enqueueError(
              'FieldsMismatchTooFew',
              `Too few fields were parsed, ${rowLength}, expected ${headerLength}.`
            )
          }
        }
        return
      } else {
        data = {}
        for (let i = 0; i < rowLength; i++) {
          data[header[i]] = row[i]
        }
      }
    }
    enqueue({ idx, data })
  }

  const enqueueError = (code, message) => {
    enqueue({ idx, err: { code, message } })
  }

  const findNext = (searchValue, start = cursor) => {
    return chunk.indexOf(searchValue, start)
  }

  const parseField = (end) => {
    return chunk.substring(cursor, end)
  }
  const transformField = (field) => {
    return coerceField(field || emptyFieldValue)
  }
  const addFieldToRow = (field) => {
    row.push(transformField(field))
  }

  // Fast Parse
  const fastParse = (string, controller) => {
    chunk = string
    chunkLength = length(chunk)
    enqueue = controller.enqueue
    const lines = chunk.split(newlineChar)
    let linesLength = length(lines)
    if (linesLength > 1) {
      partialLine = lines.pop()
      linesLength -= 1
    }
    for (const line of lines) {
      if (commentPrefixValue && line.indexOf(commentPrefixValue) === 0) {
        idx += 1
        if (errorOnComment) {
          enqueueError('CommentExists', 'Comment detected.')
        }
        continue
      }
      if (!line) {
        idx += 1
        // `linesLength > 1` to ignore end of file `\n`
        if (errorOnEmptyLine && linesLength > 1) {
          enqueueError('EmptyLineExists', 'Empty line detected.')
        }
        continue
      }
      enqueueRow(line.split(delimiterChar).map(transformField))
    }
  }

  // Slow Parse
  const checkForEmptyLine = () => {
    if (findNext(newlineChar) === cursor) {
      idx += 1
      cursor += newlineCharLength
      if (errorOnEmptyLine) {
        enqueueError('EmptyLineExists', 'Empty line detected.')
      }
      return checkForEmptyLine()
    } else if (commentPrefixValue && findNext(commentPrefixValue) === cursor) {
      idx += 1
      cursor = findNext(newlineChar) + newlineCharLength
      if (errorOnComment) {
        enqueueError('CommentExists', 'Comment detected.')
      }
      return checkForEmptyLine()
    }
  }

  const slowParse = (string, controller, flush = false) => {
    chunk = string
    chunkLength = length(chunk)
    enqueue = controller.enqueue
    partialLine = ''
    cursor = 0
    row = []

    checkForEmptyLine()
    let lineStart = 0
    for (;;) {
      let quoted
      let nextCursor = cursor
      let nextCursorLength
      let atNewline
      if (chunk[cursor] === quoteChar) {
        cursor += quoteCharLength
        quoted = true
        nextCursor = cursor
        for (;;) {
          nextCursor = findNext(quoteChar, nextCursor)
          if (nextCursor < 0) {
            partialLine = chunk.substring(lineStart, chunkLength) + partialLine
            if (flush) {
              throw new Error('QuotedFieldMalformed', { cause: idx })
            }
            return
          }
          if (
            escapedQuoteEqual &&
            chunk[nextCursor + quoteCharLength] === quoteChar
          ) {
            nextCursor += escapedQuoteCharLength
            continue
          }
          if (
            escapedQuoteNotEqual &&
            chunk[nextCursor - escapeCharLength] === escapeChar
          ) {
            nextCursor += quoteCharLength
            continue
          }
          break
        }
      }

      // fallback
      const nextDelimiterChar = findNext(delimiterChar, nextCursor)
      let nextNewlineChar = findNext(newlineChar, nextCursor)
      if (nextNewlineChar < 0) {
        if (!flush) {
          partialLine = chunk.substring(lineStart, chunkLength) + partialLine
          return
        }
        nextNewlineChar = chunkLength
      }
      if (nextDelimiterChar > -1 && nextDelimiterChar < nextNewlineChar) {
        nextCursor = nextDelimiterChar
        nextCursorLength = delimiterCharLength
      } else {
        nextCursor = nextNewlineChar
        nextCursorLength = newlineCharLength
        atNewline = true
      }

      if (nextCursor < 0 || !nextCursor) {
        break
      }

      let field
      if (quoted) {
        field = parseField(nextCursor - 1).replace(
          escapedQuoteCharRegExp,
          quoteChar
        )
      } else {
        field = parseField(nextCursor)
      }
      addFieldToRow(field)

      cursor = nextCursor + nextCursorLength

      if (atNewline) {
        enqueueRow(row)
        row = []
        checkForEmptyLine()
        lineStart = cursor
      }
      if (chunkLength <= cursor) {
        break
      }
    }
  }

  return {
    fastParse,
    slowParse,
    header: () => header,
    previousChunk: () => partialLine
  }
}

export default (input, opts) => {
  const options = {
    ...defaultOptions,
    ...{
      enableReturn: true,
      chunkSize: 64 * 1024 * 1024,
      enqueue: () => {}
    },
    ...opts
  }
  const { chunkSize, enableReturn, enqueue } = options
  const { slowParse, previousChunk } = parse(options)

  const res = []
  const controller = { enqueue }

  if (enableReturn) {
    controller.enqueue = (row) => {
      enqueue(row)
      res.push(row.data)
    }
  }

  let position = 0
  while (position < input.length) {
    const chunk =
      previousChunk() + input.substring(position, position + chunkSize)

    // Checking if you can use fastParse slows it down more than checking for quoteChar on ever field.
    slowParse(chunk, controller)
    position += chunkSize
  }
  // flush
  const chunk = previousChunk()
  slowParse(chunk, controller, true)

  return enableReturn && res
}
