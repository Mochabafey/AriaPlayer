import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/discover' },
  { path: '/discover', name: 'discover', component: () => import('../views/DiscoverView.vue'), meta: { title: '发现' } },
  { path: '/library', name: 'library', component: () => import('../views/LibraryView.vue'), meta: { title: '曲库' } },
  { path: '/resolver', name: 'resolver', component: () => import('../views/ResolverView.vue'), meta: { title: '解析' } },
  { path: '/search', name: 'search', component: () => import('../views/SearchView.vue'), meta: { title: '搜索' } },
  { path: '/profile', name: 'profile', component: () => import('../views/ProfileView.vue'), meta: { title: '我的' } },
  { path: '/downloads', name: 'downloads', component: () => import('../views/DownloadsView.vue'), meta: { title: '下载' } },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue'), meta: { title: '设置' } },
  {
    path: '/playlist/:id',
    name: 'playlist-detail',
    component: () => import('../views/PlaylistDetailView.vue'),
    meta: { title: '歌单' }
  },
  { path: '/album/:id', name: 'album-detail', component: () => import('../views/AlbumDetailView.vue'), meta: { title: '专辑' } },
  { path: '/artist/:id', name: 'artist-detail', component: () => import('../views/ArtistDetailView.vue'), meta: { title: '歌手' } },
  { path: '/mv/:id', name: 'mv-detail', component: () => import('../views/MvDetailView.vue'), meta: { title: 'MV' } },
  { path: '/:pathMatch(.*)*', redirect: '/discover' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
