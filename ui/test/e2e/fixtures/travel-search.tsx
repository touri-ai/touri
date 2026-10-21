import { useState } from "react"
import { createRoot } from "react-dom/client"
import "./travel-search.css"

const TravelSearch = () => {
  const [destination, setDestination] = useState("")
  const [suggestions, setSuggestions] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [date, setDate] = useState("")
  const [results, setResults] = useState(false)

  return (
    <main className="travel-site">
      <header className="travel-site-header">
        <a className="travel-brand" href="#search" aria-label="Travel search home">
          <span aria-hidden="true">✦</span> wayfarer
        </a>
        <span className="travel-site-note">Find your next trip</span>
      </header>
      <section className="travel-search-card" aria-label="Travel search">
        <p className="travel-eyebrow">Plan a little escape</p>
        <h1>Where would you like to go?</h1>
        <div className="travel-fields">
          <label>
            Destination
            <input
              aria-label="Destination primary"
              autoComplete="off"
              placeholder="City or airport"
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value)
                setSuggestions(Boolean(event.target.value))
              }}
            />
          </label>
          <label>
            Return destination
            <input aria-label="Destination alternate" placeholder="Optional" />
          </label>
          {suggestions && (
            <div className="travel-suggestions" role="listbox" aria-label="Destination suggestions">
              <button
                type="button"
                role="option"
                onClick={() => {
                  setDestination("Lisboa, Portugal")
                  setSuggestions(false)
                }}
              >
                <span>Lisboa, Portugal</span>
                <small>Portugal · LIS</small>
              </button>
              <button
                type="button"
                role="option"
                onClick={() => {
                  setDestination("Lisboa Airport")
                  setSuggestions(false)
                }}
              >
                <span>Lisboa Airport</span>
                <small>Airport · LIS</small>
              </button>
            </div>
          )}
          <label>
            Outbound cabin
            <select aria-label="Cabin outbound" defaultValue="economy">
              <option value="economy">Economy</option>
              <option value="business">Business</option>
            </select>
          </label>
          <label>
            Return cabin
            <select aria-label="Cabin return" defaultValue="economy">
              <option value="economy">Economy</option>
              <option value="business">Business</option>
            </select>
          </label>
        </div>
        <div className="travel-date-row">
          <button id="calendar-open" type="button" onClick={() => setCalendar((value) => !value)}>
            <span className="travel-date-icon" aria-hidden="true">
              ▦
            </span>
            {date || "Choose a departure date"}
          </button>
          {calendar && (
            <section className="travel-calendar" aria-label="Departure calendar">
              <strong>October 2026</strong>
              <fieldset className="travel-calendar-days">
                <legend>Departure dates</legend>
                <button
                  type="button"
                  aria-label="Departure date October 24"
                  onClick={() => {
                    setDate("October 24")
                    setCalendar(false)
                  }}
                >
                  24
                </button>
                <button
                  type="button"
                  aria-label="Departure date November 24"
                  onClick={() => {
                    setDate("November 24")
                    setCalendar(false)
                  }}
                >
                  24
                </button>
              </fieldset>
            </section>
          )}
        </div>
        <button
          id="search"
          className="travel-search-button"
          type="button"
          aria-label="Search trips"
          onClick={() => setResults(true)}
        >
          <span>Search trips</span>
          <span aria-hidden="true">→</span>
        </button>
        {results && (
          <section className="travel-results" aria-label="Search results">
            <div className="travel-results-heading">
              <div>
                <p className="travel-eyebrow">Your shortlist</p>
                <h2>Two ways to get there</h2>
              </div>
              <span className="travel-result-count">2 trips</span>
            </div>
            <article className="travel-result">
              <div className="travel-result-mark" aria-hidden="true">
                ✈
              </div>
              <div>
                <strong>Direct flight</strong>
                <small>2 h 30 min · No stops</small>
              </div>
              <b>€184</b>
            </article>
            <article className="travel-result">
              <div className="travel-result-mark travel-result-mark-soft" aria-hidden="true">
                ↗
              </div>
              <div>
                <strong>One connection</strong>
                <small>4 h 10 min · 1 stop</small>
              </div>
              <b>€139</b>
            </article>
          </section>
        )}
      </section>
      <footer className="travel-site-footer">A local sample search with fictional fares</footer>
    </main>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<TravelSearch />)
