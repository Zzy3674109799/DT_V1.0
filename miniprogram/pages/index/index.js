const app = getApp();
const PI = Math.PI;
function outOfChina(lat, lng) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function transformLat(x, y) { let ret = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x)); ret += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; ret += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3; ret += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3; return ret; }
function transformLng(x, y) { let ret = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x)); ret += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3; ret += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3; ret += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3; return ret; }
function wgs84ToGcj02(lat, lng) { if (outOfChina(lat, lng)) return { latitude: lat, longitude: lng }; const a = 6378245; const ee = .00669342162296594323; const dLat = transformLat(lng - 105, lat - 35) * 180 / (a * (1 - ee) / Math.pow(1 - ee * Math.sin(lat * PI / 180) ** 2, 1.5) * PI); const dLng = transformLng(lng - 105, lat - 35) * 180 / (a / Math.sqrt(1 - ee * Math.sin(lat * PI / 180) ** 2) * Math.cos(lat * PI / 180) * PI); return { latitude: lat + dLat, longitude: lng + dLng }; }

Page({
  data: { loading: true, dashboard: null, markers: [], selectedPlace: null },

  onShow() { this.loadDashboard(); },

  request(path, options = {}) {
    const token = app.globalData.accessToken || wx.getStorageSync('xingji_token');
    return new Promise((resolve, reject) => wx.request({
      url: `${app.globalData.apiBaseUrl}${path}`,
      ...options,
      header: { ...(options.header || {}), Authorization: token ? `Bearer ${token}` : '' },
      success: resolve,
      fail: reject
    }));
  },

  async loadDashboard() {
    try {
      const response = await this.request('/api/dashboard');
      if (response.statusCode !== 200) throw new Error('请先完成微信登录');
      const dashboard = response.data;
      this.setData({ dashboard, loading: false, markers: (dashboard.places || []).filter((place) => place.lat && place.lng).map((place) => ({
        id: place.id, ...wgs84ToGcj02(Number(place.lat), Number(place.lng)), title: place.name,
        width: place.lit ? 30 : 22, height: place.lit ? 30 : 22, callout: { content: place.name, display: 'BYCLICK' }
      })) });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  onMarkerTap(event) {
    const place = (this.data.dashboard?.places || []).find((item) => item.id === event.detail.markerId);
    this.setData({ selectedPlace: place || null });
  },

  checkin() {
    const place = this.data.selectedPlace || (this.data.dashboard?.places || [])[0];
    if (!place) return wx.showToast({ title: '暂无地点', icon: 'none' });
    wx.getLocation({
      type: 'gcj02',
      success: (location) => this.request('/api/v1/visits', { method: 'POST', data: {
        placeId: place.id, visitType: place.kind === 'mountain' ? 'summit' : 'visited', visitedAt: new Date().toISOString().slice(0, 10),
        latitude: location.latitude, longitude: location.longitude, coordinateSystem: 'gcj02', accuracyM: location.accuracy
      }}).then((response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) { wx.showToast({ title: response.data.visit.verification_status === 'verified' ? '已点亮' : '等待复核', icon: 'success' }); this.loadDashboard(); }
        else wx.showToast({ title: response.data.message || '打卡失败', icon: 'none' });
      }),
      fail: () => wx.showToast({ title: '需要定位权限才能打卡', icon: 'none' })
    });
  }
});
