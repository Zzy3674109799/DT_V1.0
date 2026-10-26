const config = require('./config');

App({
  globalData: { apiBaseUrl: config.apiBaseUrl, accessToken: '' },
  onLaunch() {
    wx.login({
      success: ({ code }) => {
        if (!code) return;
        wx.request({
          url: `${config.apiBaseUrl}/api/v1/auth/wechat-login`,
          method: 'POST',
          data: { code },
          success: (response) => {
            if (response.statusCode === 200 && response.data.accessToken) {
              this.globalData.accessToken = response.data.accessToken;
              wx.setStorageSync('xingji_token', response.data.accessToken);
            }
          }
        });
      }
    });
  }
});
