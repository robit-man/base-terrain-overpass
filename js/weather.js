/**
 * Weather module - fetches and manages weather data from Open-Meteo API
 */

export class WeatherManager {
  constructor() {
    this.current = null;
    this.hourly = null;
    this.daily = null;
    this.lastUpdate = null;
    this.updateInterval = 10 * 60 * 1000; // 10 minutes
    this.lat = null;
    this.lon = null;
    this._updateTimer = null;
  }

  /**
   * Start weather updates for a location
   * @param {number} lat - Latitude
   * @param {number} lon - Longitude
   */
  start(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    this.fetchWeather();

    // Set up periodic updates
    if (this._updateTimer) clearInterval(this._updateTimer);
    this._updateTimer = setInterval(() => this.fetchWeather(), this.updateInterval);
  }

  /**
   * Stop weather updates
   */
  stop() {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
  }

  /**
   * Update location and fetch new weather data
   */
  updateLocation(lat, lon) {
    const latChanged = Math.abs(this.lat - lat) > 0.01;
    const lonChanged = Math.abs(this.lon - lon) > 0.01;

    if (latChanged || lonChanged) {
      this.lat = lat;
      this.lon = lon;
      this.fetchWeather();
    }
  }

  /**
   * Fetch weather data from Open-Meteo API
   */
  async fetchWeather() {
    if (!Number.isFinite(this.lat) || !Number.isFinite(this.lon)) {
      console.warn('WeatherManager: Invalid coordinates', this.lat, this.lon);
      return;
    }

    const params = new URLSearchParams({
      latitude: this.lat.toFixed(4),
      longitude: this.lon.toFixed(4),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m',
      hourly: 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,rain,weather_code,cloud_cover,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max',
      temperature_unit: 'celsius',
      wind_speed_unit: 'kmh',
      precipitation_unit: 'mm',
      timezone: 'auto',
      forecast_days: 7
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }

      const data = await response.json();
      this.current = data.current;
      this.hourly = data.hourly;
      this.daily = data.daily;
      this.lastUpdate = Date.now();

      // Dispatch event for listeners
      window.dispatchEvent(new CustomEvent('weather-updated', { detail: this.getWeatherData() }));

      console.log('Weather updated:', this.current);
    } catch (err) {
      console.error('Failed to fetch weather:', err);
    }
  }

  /**
   * Get current weather data
   */
  getWeatherData() {
    return {
      current: this.current,
      hourly: this.hourly,
      daily: this.daily,
      lastUpdate: this.lastUpdate
    };
  }

  /**
   * Get weather code description
   */
  getWeatherDescription(code) {
    const codes = {
      0: 'Clear',
      1: 'Mostly Clear',
      2: 'Partly Cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Foggy',
      51: 'Light Drizzle',
      53: 'Drizzle',
      55: 'Heavy Drizzle',
      61: 'Light Rain',
      63: 'Rain',
      65: 'Heavy Rain',
      71: 'Light Snow',
      73: 'Snow',
      75: 'Heavy Snow',
      77: 'Snow Grains',
      80: 'Light Showers',
      81: 'Showers',
      82: 'Heavy Showers',
      85: 'Light Snow Showers',
      86: 'Snow Showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm',
      99: 'Thunderstorm'
    };
    return codes[code] || 'Unknown';
  }

  /**
   * Get weather icon/emoji for code
   */
  getWeatherIcon(code) {
    if (code === 0) return '☀️';
    if (code === 1) return '🌤️';
    if (code === 2) return '⛅';
    if (code === 3) return '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 55) return '🌦️';
    if (code >= 61 && code <= 65) return '🌧️';
    if (code >= 71 && code <= 77) return '🌨️';
    if (code >= 80 && code <= 82) return '🌧️';
    if (code >= 85 && code <= 86) return '🌨️';
    if (code >= 95) return '⛈️';
    return '❓';
  }

  /**
   * Get daily forecast for next N days
   */
  getDailyForecast(days = 7) {
    if (!this.daily) return [];

    const forecast = [];
    const maxDays = Math.min(days, this.daily.time?.length || 0);

    for (let i = 0; i < maxDays; i++) {
      forecast.push({
        date: this.daily.time[i],
        weatherCode: this.daily.weather_code[i],
        tempMax: this.daily.temperature_2m_max[i],
        tempMin: this.daily.temperature_2m_min[i],
        precipitation: this.daily.precipitation_sum[i],
        precipProb: this.daily.precipitation_probability_max[i],
        windSpeed: this.daily.wind_speed_10m_max[i]
      });
    }

    return forecast;
  }
}
