import { loadDotEnvFiles } from './ingest-utils'
loadDotEnvFiles()

async function testRelease(rid: number, name: string, params?: Record<string, string>) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) {
    console.log('No FRED_API_KEY')
    process.exit(1)
  }

  const url = new URL('https://api.stlouisfed.org/fred/release/dates')
  url.searchParams.set('release_id', String(rid))
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('file_type', 'json')
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }

  console.log(`  URL: ${url.toString().replace(apiKey, 'REDACTED')}`)
  const res = await fetch(url.toString(), { cache: 'no-store' })
  const text = await res.text()

  if (!res.ok) {
    console.log(`${name} (rid=${rid}): HTTP ${res.status}`)
    console.log(`  Body: ${text.slice(0, 300)}`)
    return
  }

  const json = JSON.parse(text)
  const dates = json.release_dates?.map((d: { date: string }) => d.date) || []
  console.log(`${name} (rid=${rid}): ${dates.length} dates`)
  if (dates.length > 0) {
    console.log(`  First 3: ${dates.slice(0, 3).join(', ')}`)
    console.log(`  Last 3:  ${dates.slice(-3).join(', ')}`)
  }
}

async function main() {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  console.log('\n=== Testing Housing Starts (29) and Existing Home Sales (291) ===')
  await testRelease(29, 'Housing Starts', { realtime_start: '2020-01-01', include_release_dates_with_no_data: 'false' })
  await sleep(600)
  await testRelease(291, 'Existing Home Sales', { realtime_start: '2020-01-01', include_release_dates_with_no_data: 'false' })
  await sleep(600)

  // Check what release the series HOUST actually belongs to
  console.log('\n=== Testing corrected Housing Starts (27) ===')
  await testRelease(27, 'Housing Starts (rid=27)', { realtime_start: '2020-01-01', include_release_dates_with_no_data: 'false' })
  await sleep(600)

  console.log('\n=== Testing Existing Home Sales with no realtime_start ===')
  await testRelease(291, 'Existing Home Sales (no realtime_start)', { include_release_dates_with_no_data: 'false' })
}

main().catch(console.error)
