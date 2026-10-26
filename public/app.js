const $ = (selector) => document.querySelector(selector);
const state = { data: null, token: localStorage.getItem('xingji_token') };

async function ensureSession() {
  if (state.token) return state.token;
  const response = await fetch('/api/v1/auth/dev-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'demo-user', nickname: '山野小队长' })
  });
  if (!response.ok) throw new Error('开发登录失败');
  const data = await response.json();
  state.token = data.accessToken;
  localStorage.setItem('xingji_token', state.token);
  return state.token;
}

async function apiFetch(url, options = {}) {
  const token = await ensureSession();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function renderStats(stats) {
  const items = [
    ['已点亮地点', stats.places_lit, 'Places lit', '本季 +2'],
    ['旅行记录', stats.visits_count, 'Memories', '持续增加'],
    ['累计积分', stats.score, 'Season points', '↗ 18%'],
    ['走过省份', stats.provinces, 'Provinces', '中国行迹']
  ];
  $('#stats').innerHTML = items.map(([label, value, sub, trend]) => `<div class="stat"><span class="trend">${trend}</span><div class="value">${value}</div><div class="label">${label} · ${sub}</div></div>`).join('');
}

function renderMap(places) {
  const stage = $('#mapStage');
  stage.querySelectorAll('.pin').forEach((pin) => pin.remove());
  places.forEach((place) => {
    const pin = document.createElement('button');
    pin.className = `pin ${place.lit ? (place.kind === 'mountain' ? 'summit' : '') : 'planned'}`;
    pin.style.left = `${place.map_x}%`;
    pin.style.top = `${place.map_y}%`;
    pin.title = `${place.name} · ${place.province}`;
    pin.innerHTML = `<span>${place.name}</span>`;
    pin.addEventListener('click', () => showToast(`${place.name} · ${place.description}`));
    stage.appendChild(pin);
  });
  $('#mapCount').textContent = `${places.filter((p) => p.lit).length} / ${places.length} 个地点已点亮`;
}

function renderChallenges(challenges) {
  $('#challengeList').innerHTML = challenges.map((challenge) => {
    const percent = challenge.target_count ? Math.round((challenge.completed_count / challenge.target_count) * 100) : 0;
    return `<div class="challenge-item"><div class="challenge-badge">${challenge.badge === '金色山河' ? '✦' : challenge.badge === '周末行者' ? '◒' : '⌁'}</div><div><h3>${challenge.name}</h3><p>${challenge.description}</p></div><div class="challenge-progress">${challenge.completed_count}/${challenge.target_count}<div class="challenge-bar"><i style="width:${percent}%"></i></div></div></div>`;
  }).join('');
  const mountain = challenges.find((c) => c.name === '中国名山打卡季');
  const completed = mountain ? mountain.completed_count : 0;
  const target = mountain ? mountain.target_count : 5;
  $('#seasonProgress').style.width = `${Math.min(100, Math.round((completed / Math.max(target, 1)) * 100))}%`;
  $('#progressText').textContent = `${completed} / ${target}`;
}

function renderActivities(visits) {
  const icons = { summit: '▲', visited: '✦', planned: '○' };
  $('#activityList').innerHTML = visits.length ? visits.map((visit) => `<div class="activity-item"><div class="activity-icon">${icons[visit.visit_type] || '✦'}</div><div><strong>${visit.visit_type === 'summit' ? '登顶了' : visit.visit_type === 'planned' ? '计划前往' : '点亮了'} · ${visit.name}</strong><small>${visit.province} · ${visit.visited_at}${visit.note ? ` · ${visit.note}` : ''}</small></div></div>`).join('') : '<p class="muted">还没有记录，去点亮第一个地方吧。</p>';
}

function renderTrips(trips) {
  const target = $('#tripList');
  if (!trips.length) {
    target.innerHTML = '<p class="muted">还没有行程，先点亮一个地方吧。</p>';
    return;
  }
  target.innerHTML = trips.slice(0, 3).map((trip) => `<div class="trip-row"><div><strong>${trip.name}</strong><small>${trip.start_at || '待定'}${trip.end_at ? ` → ${trip.end_at}` : ''}</small></div><span>${trip.day_count} 天 · ${trip.item_count} 项</span></div>`).join('');
}

function renderPacks(packs) {
  const pack = packs[0];
  if (!pack) {
    $('#packName').textContent = '还没有 PACK';
    $('#packMeta').textContent = '创建一支队伍，和朋友一起出发';
    return null;
  }
  $('#packName').textContent = pack.name;
  $('#packMeta').textContent = `${pack.member_count} 位成员 · ${pack.post_count} 条动态`;
  return pack;
}

function renderFeed(posts) {
  const target = $('#feedList');
  if (!posts.length) {
    target.innerHTML = '<p class="muted">PACK 还没有动态，发布第一条出发记录吧。</p>';
    return;
  }
  target.innerHTML = posts.slice(0, 4).map((post) => `<div class="feed-row"><div class="feed-avatar">${(post.author_nickname || '行').slice(0, 1)}</div><div><strong>${post.author_nickname || '山野行者'}</strong><p>${post.content}</p><small>♥ ${post.like_count}　评论 ${post.comment_count}</small></div></div>`).join('');
}

function renderLeaderboard(rows) {
  const target = $('#leaderboardList');
  if (!rows.length) {
    target.innerHTML = '<p class="muted">本季还没有积分记录。</p>';
    return;
  }
  target.innerHTML = rows.slice(0, 5).map((row) => `<div class="leader-row"><span class="leader-rank">${row.rank}</span><strong>${row.nickname}</strong><span>${row.score} 分</span></div>`).join('');
}

function fillPlaceSelect(places) {
  $('#placeId').innerHTML = places.map((place) => `<option value="${place.id}">${place.name} · ${place.province}</option>`).join('');
}

function renderCommerceActivities(activities) {
  const target = $('#activityCommerceList');
  if (!activities.length) { target.innerHTML = '<p class="muted">近期没有公开活动。</p>'; return; }
  target.innerHTML = activities.slice(0, 4).map((activity) => `<div class="commerce-row"><div><strong>${activity.title}</strong><small>${activity.merchant_name || '官方活动'} · ${new Date(activity.start_at).toLocaleDateString('zh-CN')} · ${activity.remaining_capacity > 0 ? `剩余 ${activity.remaining_capacity} 名` : '名额已满'}</small></div><div class="commerce-action"><b>¥${Number(activity.price_yuan).toFixed(2)}</b><button class="text-button join-activity" data-id="${activity.id}" ${activity.remaining_capacity === 0 ? 'disabled' : ''}>报名</button></div></div>`).join('');
  target.querySelectorAll('.join-activity').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const orderResponse = await apiFetch(`/api/v1/activities/${button.dataset.id}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ couponCode: ($('#activityCoupon')?.value || '').trim() }) });
      const orderData = await orderResponse.json();
      if (!orderResponse.ok) throw new Error(orderData.message || '创建订单失败');
      const payResponse = await apiFetch(`/api/v1/orders/${orderData.order.order_no}/pay`, { method: 'POST' });
      const payData = await payResponse.json();
      if (!payResponse.ok) throw new Error(payData.message || '支付失败');
      showToast('报名成功，活动已加入你的行程 ✦');
      await loadCommerce();
    } catch (error) { showToast(error.message); button.disabled = false; }
  }));
}

function renderMembership(membership, plans) {
  const info = $('#membershipInfo');
  info.innerHTML = membership ? `<div class="member-current"><strong>${membership.name}</strong><span>有效至 ${new Date(membership.end_at).toLocaleDateString('zh-CN')}</span><small>媒体额度 ${membership.monthly_media_quota}/月</small></div>` : '<div class="member-current"><strong>山野基础版</strong><span>当前为免费会员</span><small>升级会员，解锁更高媒体额度和高级挑战</small></div>';
  $('#membershipPlans').innerHTML = plans.filter((plan) => plan.code !== 'free').map((plan) => `<button class="plan-button" data-code="${plan.code}"><span>${plan.name}</span><b>¥${Number(plan.price_yuan).toFixed(2)}</b></button>`).join('');
  $('#membershipPlans').querySelectorAll('.plan-button').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await apiFetch('/api/v1/membership/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planCode: button.dataset.code }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '订阅失败');
      showToast('会员已激活（演示支付）');
      await loadCommerce();
    } catch (error) { showToast(error.message); button.disabled = false; }
  }));
}

async function loadCommerce() {
  const [activitiesResponse, membershipResponse, plansResponse] = await Promise.all([apiFetch('/api/v1/activities'), apiFetch('/api/v1/membership/me'), apiFetch('/api/v1/membership/plans')]);
  if (!activitiesResponse.ok || !membershipResponse.ok || !plansResponse.ok) throw new Error('商业服务暂不可用');
  const activities = await activitiesResponse.json();
  const membership = await membershipResponse.json();
  const plans = await plansResponse.json();
  renderCommerceActivities(activities.activities || []);
  renderMembership(membership.membership, plans.plans || []);
}

async function loadDashboard() {
  const [response, tripsResponse, challengeResponse, packsResponse, leaderboardResponse] = await Promise.all([apiFetch('/api/dashboard'), apiFetch('/api/v1/trips'), apiFetch('/api/v1/challenges'), apiFetch('/api/v1/packs'), apiFetch('/api/v1/leaderboards/2026')]);
  if (!response.ok || !tripsResponse.ok || !challengeResponse.ok || !packsResponse.ok || !leaderboardResponse.ok) throw new Error('无法加载数据');
  state.data = await response.json();
  const trips = await tripsResponse.json();
  const challengeData = await challengeResponse.json();
  const packsData = await packsResponse.json();
  const leaderboardData = await leaderboardResponse.json();
  const pack = renderPacks(packsData.packs || []);
  const feedResponse = await apiFetch(pack ? `/api/v1/feed?packId=${pack.id}` : '/api/v1/feed');
  const feedData = feedResponse.ok ? await feedResponse.json() : { posts: [] };
  renderStats(state.data.stats);
  renderMap(state.data.places);
  renderChallenges(challengeData.challenges || state.data.challenges);
  renderActivities(state.data.visits);
  renderTrips(trips.trips || []);
  renderFeed(feedData.posts || []);
  renderLeaderboard(leaderboardData.leaderboard || []);
  fillPlaceSelect(state.data.places);
}

$('#openCheckin').addEventListener('click', () => $('#checkinDialog').showModal());
$('#scrollChallenges').addEventListener('click', () => $('#challenges').scrollIntoView({ behavior: 'smooth' }));
$('#visitedAt').value = new Date().toISOString().slice(0, 10);
$('#checkinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = { placeId: Number($('#placeId').value), visitType: $('#visitType').value, visitedAt: $('#visitedAt').value, note: $('#note').value };
  if (payload.visitType !== 'planned' && navigator.geolocation) {
    try {
      const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 3000, maximumAge: 60000 }));
      payload.latitude = position.coords.latitude;
      payload.longitude = position.coords.longitude;
      payload.accuracyM = position.coords.accuracy;
    } catch (_error) {
      showToast('未取得定位，本次记录将进入人工复核');
    }
  }
  const response = await apiFetch('/api/v1/visits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { showToast(result.message || '保存失败，请稍后再试'); return; }
  $('#checkinDialog').close();
  $('#note').value = '';
  await loadDashboard();
  showToast(result.visit?.verification_status === 'manual_review' ? '已提交，等待人工复核' : '已保存，地图点亮成功 ✦');
});

loadDashboard().then(() => loadCommerce()).catch((error) => showToast(error.message));
