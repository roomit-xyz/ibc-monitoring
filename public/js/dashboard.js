/**
 * IBC Monitor Dashboard
 * Developed by PT Roomit Trimiko Digital
 * https://roomit.xyz
 */

class IBCDashboard {
    constructor() {
        this.user = null;
        this.token = null;
        this.wsConnection = null;
        this.dashboardData = {};
        this.isAuthenticated = false;

        this.initializeAuth();
    }

    async initializeAuth() {
        try {
            // Check authentication status
            const response = await fetch('/api/auth/status', {
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                if (data.authenticated) {
                    this.user = data.user;
                    this.token = localStorage.getItem('token');
                    this.isAuthenticated = true;
                    
                    await this.initializeDashboard();
                    return;
                }
            }

            // Not authenticated, redirect to login
            window.location.href = '/login';

        } catch (error) {
            console.error('Authentication check failed:', error);
            window.location.href = '/login';
        }
    }

    async initializeDashboard() {
        try {
            // Setup UI
            this.setupUI();
            this.setupEventListeners();
            
            // Load initial data
            await this.loadDashboardData();
            
            // Setup WebSocket connection
            this.setupWebSocket();
            
            // Start periodic updates
            this.startPeriodicUpdates();
            
            // Hide loading screen
            this.hideLoadingScreen();

        } catch (error) {
            console.error('Dashboard initialization failed:', error);
            this.showError('Failed to initialize dashboard');
        }
    }

    setupUI() {
        // Set user information
        document.getElementById('userName').textContent = this.user.username;
        document.getElementById('menuUserName').textContent = this.user.username;
        document.getElementById('menuUserRole').textContent = this.user.role.charAt(0).toUpperCase() + this.user.role.slice(1);
        document.getElementById('userAvatar').textContent = this.user.username.charAt(0).toUpperCase();

        // Show/hide admin link based on role
        if (this.user.role === 'admin') {
            document.getElementById('adminLink').classList.remove('hidden');
        }

        // Update connection status
        this.updateConnectionStatus(true);
    }

    setupEventListeners() {
        // User menu toggle
        document.getElementById('userMenuBtn').addEventListener('click', () => {
            const menu = document.getElementById('userMenu');
            menu.classList.toggle('hidden');
        });

        // Close user menu when clicking outside
        document.addEventListener('click', (e) => {
            const userMenuBtn = document.getElementById('userMenuBtn');
            const userMenu = document.getElementById('userMenu');
            
            if (!userMenuBtn.contains(e.target) && !userMenu.contains(e.target)) {
                userMenu.classList.add('hidden');
            }
        });

        // Logout button
        document.getElementById('logoutBtn').addEventListener('click', async () => {
            await this.logout();
        });

        // Notification settings
        document.getElementById('notificationBtn').addEventListener('click', () => {
            this.showNotificationSettings();
        });

        // Notification modal buttons
        document.getElementById('notificationCancel').addEventListener('click', () => {
            this.hideNotificationSettings();
        });

        document.getElementById('saveNotification').addEventListener('click', async () => {
            await this.saveNotificationSettings();
        });

        document.getElementById('testNotification').addEventListener('click', async () => {
            await this.testNotification();
        });

        // Toast close button
        document.getElementById('closeToast').addEventListener('click', () => {
            this.hideToast();
        });
    }

    async loadDashboardData() {
        try {
            this.showLoading();

            // Load wallet balances
            await this.loadWalletBalances();

            // Load dashboard metrics
            const response = await fetch('/api/metrics/dashboard', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                credentials: 'include'
            });

            if (response.ok) {
                this.dashboardData = await response.json();
                this.updateDashboard();
            } else {
                throw new Error('Failed to load dashboard data');
            }

            // Load notification settings
            await this.loadNotificationSettings();

        } catch (error) {
            console.error('Failed to load dashboard data:', error);
            this.showError('Failed to load data');
        } finally {
            this.hideLoading();
        }
    }

    updateDashboard() {
        // Update status cards
        document.getElementById('chainCount').textContent = this.dashboardData.chains?.length || 0;
        document.getElementById('workerCount').textContent = this.dashboardData.totalWorkers || 0;
        document.getElementById('alertCount').textContent = this.dashboardData.alerts?.length || 0;
        document.getElementById('sourceCount').textContent = this.dashboardData.sources || 0;

        // Update chains list
        this.updateChainsList();

        // Update alerts list
        this.updateAlertsList();

        // Update workers list
        this.updateWorkersList();

        // Update last update time
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
    }

    updateChainsList() {
        const container = document.getElementById('chainsList');
        
        if (!this.dashboardData.chains || this.dashboardData.chains.length === 0) {
            container.innerHTML = '<div class="text-center text-gray-500 py-8">No chains detected</div>';
            return;
        }

        const chainsHtml = this.dashboardData.chains.map(chain => `
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors slide-up">
                <div class="flex-1">
                    <div class="font-medium text-gray-900">${this.escapeHtml(chain.name || chain.id)}</div>
                    <div class="text-sm text-gray-600">ID: ${this.escapeHtml(chain.id)}</div>
                </div>
                <span class="px-3 py-1 text-xs font-medium rounded-full ${this.getStatusClasses(chain.status)}">
                    ${this.getStatusText(chain.status)}
                </span>
            </div>
        `).join('');

        container.innerHTML = chainsHtml;
    }

    updateAlertsList() {
        const container = document.getElementById('alertsList');
        const badge = document.getElementById('alertBadge');
        
        if (!this.dashboardData.alerts || this.dashboardData.alerts.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <span class="text-green-600 text-2xl">✅</span>
                    </div>
                    <p class="text-green-600 font-medium">All systems operational</p>
                    <p class="text-gray-500 text-sm mt-1">No alerts detected</p>
                </div>
            `;
            badge.classList.add('hidden');
            return;
        }

        badge.textContent = this.dashboardData.alerts.length;
        badge.classList.remove('hidden');

        const alertsHtml = this.dashboardData.alerts.slice(0, 5).map(alert => `
            <div class="flex items-center justify-between p-3 rounded-lg border-l-4 slide-up ${this.getAlertBorderClass(alert.severity)}">
                <div class="flex-1">
                    <div class="font-medium ${this.getAlertTextClass(alert.severity)}">
                        ${this.escapeHtml(alert.type)} ${alert.chain ? `- ${this.escapeHtml(alert.chain)}` : ''}
                    </div>
                    <div class="text-sm ${this.getAlertDescClass(alert.severity)}">
                        ${this.escapeHtml(alert.message)}
                    </div>
                </div>
                <span class="px-2 py-1 text-xs font-medium rounded ${this.getAlertBadgeClass(alert.severity)}">
                    ${alert.severity}
                </span>
            </div>
        `).join('');

        container.innerHTML = alertsHtml;
    }

    updateWorkersList() {
        const container = document.getElementById('workersList');
        
        if (!this.dashboardData.workerSummary || Object.keys(this.dashboardData.workerSummary).length === 0) {
            container.innerHTML = '<div class="col-span-full text-center text-gray-500 py-8">No worker data available</div>';
            return;
        }

        const workersHtml = Object.entries(this.dashboardData.workerSummary).map(([type, count]) => `
            <div class="bg-gray-50 rounded-lg p-4 hover:bg-gray-100 transition-colors slide-up">
                <div class="flex items-center justify-between mb-2">
                    <div class="font-medium text-gray-900">${this.escapeHtml(type)}</div>
                    <div class="text-lg font-bold text-blue-600">${count}</div>
                </div>
                <div class="text-sm text-gray-600">
                    Active ${type.toLowerCase()} workers
                </div>
            </div>
        `).join('');

        container.innerHTML = workersHtml;
    }

    setupWebSocket() {
        if (!this.token) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws?token=${this.token}`;

        this.wsConnection = new WebSocket(wsUrl);

        this.wsConnection.onopen = () => {
            console.log('WebSocket connected');
            this.updateConnectionStatus(true, 'Connected');
            
            // Subscribe to updates
            this.wsConnection.send(JSON.stringify({
                type: 'subscribe',
                data: { channel: 'metrics' }
            }));

            this.wsConnection.send(JSON.stringify({
                type: 'subscribe',
                data: { channel: 'alerts' }
            }));
        };

        this.wsConnection.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleWebSocketMessage(message);
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error);
            }
        };

        this.wsConnection.onclose = () => {
            console.log('WebSocket disconnected');
            this.updateConnectionStatus(false, 'Disconnected');
            
            // Attempt to reconnect after 5 seconds
            setTimeout(() => {
                this.setupWebSocket();
            }, 5000);
        };

        this.wsConnection.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.updateConnectionStatus(false, 'Error');
        };
    }

    handleWebSocketMessage(message) {
        switch (message.type) {
            case 'welcome':
                console.log('WebSocket welcome:', message.data);
                break;

            case 'metrics_update':
                this.handleMetricsUpdate(message.data);
                break;

            case 'new_alert':
                this.handleNewAlert(message.data);
                break;

            case 'alerts_update':
                this.handleAlertsUpdate(message.data);
                break;

            case 'balance_update':
                this.handleWalletUpdate(message.data);
                break;

            case 'wallet_alert':
                this.handleWalletAlert(message.data);
                break;

            case 'error':
                console.error('WebSocket error:', message.data);
                break;

            default:
                console.log('Unknown WebSocket message:', message);
        }
    }

    handleMetricsUpdate(data) {
        // Update dashboard with real-time metrics
        if (data.analysis) {
            // Update chain count
            if (data.analysis.chains) {
                const currentChains = document.getElementById('chainCount').textContent;
                if (currentChains !== String(data.analysis.chains.length)) {
                    document.getElementById('chainCount').textContent = data.analysis.chains.length;
                }
            }

            // Update worker count
            if (data.analysis.summary?.totalWorkers !== undefined) {
                const currentWorkers = document.getElementById('workerCount').textContent;
                if (currentWorkers !== String(data.analysis.summary.totalWorkers)) {
                    document.getElementById('workerCount').textContent = data.analysis.summary.totalWorkers;
                }
            }

            // Update alerts count
            if (data.analysis.alertsCount !== undefined) {
                const currentAlerts = document.getElementById('alertCount').textContent;
                if (currentAlerts !== String(data.analysis.alertsCount)) {
                    document.getElementById('alertCount').textContent = data.analysis.alertsCount;
                }
            }
        }

        // Update last update time
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
    }

    handleNewAlert(alertData) {
        this.showToast(alertData.formatted?.title || 'New Alert', alertData.formatted?.message || alertData.message, alertData.severity);
        
        // Update alert count
        const currentCount = parseInt(document.getElementById('alertCount').textContent) || 0;
        document.getElementById('alertCount').textContent = currentCount + 1;
    }

    handleAlertsUpdate(data) {
        if (data.alerts && data.alerts.length > 0) {
            // Show toast for the most critical alert
            const criticalAlerts = data.alerts.filter(alert => alert.severity === 'critical');
            const alertToShow = criticalAlerts.length > 0 ? criticalAlerts[0] : data.alerts[0];
            
            this.showToast(
                `${alertToShow.type} - ${data.source}`, 
                alertToShow.message, 
                alertToShow.severity
            );
        }
    }

    startPeriodicUpdates() {
        // Refresh dashboard data every 30 seconds
        setInterval(async () => {
            try {
                await this.loadDashboardData();
            } catch (error) {
                console.error('Periodic update failed:', error);
            }
        }, 30000);
    }

    async logout() {
        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include'
            });

            // Clean up local storage and redirect
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            
            if (this.wsConnection) {
                this.wsConnection.close();
            }

            window.location.href = '/login';

        } catch (error) {
            console.error('Logout failed:', error);
            // Force redirect even if logout request fails
            window.location.href = '/login';
        }
    }

    async loadNotificationSettings() {
        try {
            const response = await fetch('/api/alerts/notifications', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                this.updateNotificationStatus(data.settings);
            }
        } catch (error) {
            console.error('Failed to load notification settings:', error);
        }
    }

    updateNotificationStatus(settings) {
        const statusElement = document.getElementById('notificationStatus');
        
        if (settings.isEnabled && settings.gotifyUrl) {
            statusElement.textContent = 'Notifications: Enabled';
            statusElement.className = 'text-green-600';
        } else {
            statusElement.textContent = 'Notifications: Disabled';
            statusElement.className = 'text-gray-400';
        }
    }

    showNotificationSettings() {
        // Load current settings into modal
        this.loadNotificationSettings().then(() => {
            document.getElementById('notificationModal').classList.remove('hidden');
        });
    }

    hideNotificationSettings() {
        document.getElementById('notificationModal').classList.add('hidden');
    }

    async saveNotificationSettings() {
        try {
            const settings = {
                gotifyUrl: document.getElementById('gotifyUrl').value,
                gotifyToken: document.getElementById('gotifyToken').value,
                isEnabled: document.getElementById('gotifyEnabled').checked
            };

            const response = await fetch('/api/alerts/notifications', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                credentials: 'include',
                body: JSON.stringify(settings)
            });

            if (response.ok) {
                this.showToast('Settings Saved', 'Notification settings updated successfully', 'info');
                this.hideNotificationSettings();
                await this.loadNotificationSettings();
            } else {
                const error = await response.json();
                this.showToast('Save Failed', error.error || 'Failed to save settings', 'warning');
            }

        } catch (error) {
            console.error('Failed to save notification settings:', error);
            this.showToast('Save Failed', 'Failed to save settings', 'warning');
        }
    }

    async testNotification() {
        try {
            const response = await fetch('/api/alerts/notifications/test', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                credentials: 'include'
            });

            if (response.ok) {
                this.showToast('Test Sent', 'Test notification sent successfully', 'info');
            } else {
                const error = await response.json();
                this.showToast('Test Failed', error.error || 'Failed to send test notification', 'warning');
            }

        } catch (error) {
            console.error('Failed to test notification:', error);
            this.showToast('Test Failed', 'Failed to send test notification', 'warning');
        }
    }

    // Wallet Balance Methods
    async loadWalletBalances() {
        try {
            document.getElementById('walletLoading').classList.remove('hidden');

            const response = await fetch('/api/wallets/summary', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                this.walletData = data.summary;
                this.updateWalletDisplay();
                
                // Also load detailed balances
                await this.loadDetailedBalances();
            } else {
                throw new Error('Failed to load wallet summary');
            }

        } catch (error) {
            console.error('Failed to load wallet balances:', error);
            this.showError('Failed to load wallet balances');
        } finally {
            document.getElementById('walletLoading').classList.add('hidden');
        }
    }

    async loadDetailedBalances() {
        try {
            const response = await fetch('/api/wallets/balances', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                this.detailedBalances = data.balances;
            }

        } catch (error) {
            console.error('Failed to load detailed balances:', error);
        }
    }

    updateWalletDisplay() {
        if (!this.walletData) return;

        // Update total portfolio value
        const totalValue = this.walletData.total_usd_value || 0;
        document.getElementById('totalPortfolioValue').textContent = `Total: $${totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

        // Update summary cards
        const summaryContainer = document.getElementById('walletSummaryCards');
        summaryContainer.innerHTML = '';

        this.walletData.chains.forEach(chain => {
            const card = this.createWalletSummaryCard(chain);
            summaryContainer.appendChild(card);
        });

        // Update detailed view if it's shown
        if (!document.getElementById('walletDetailsSection').classList.contains('hidden')) {
            this.updateDetailedWalletView();
        }
    }

    createWalletSummaryCard(chain) {
        const card = document.createElement('div');
        card.className = 'bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-4 border border-blue-200';
        
        const totalValue = chain.total_usd_value || 0;
        const statusColor = totalValue < 10 ? 'text-red-600' : totalValue < 50 ? 'text-yellow-600' : 'text-green-600';
        const statusIcon = totalValue < 10 ? '🔴' : totalValue < 50 ? '🟡' : '🟢';

        card.innerHTML = `
            <div class="flex items-center justify-between mb-2">
                <h4 class="font-medium text-gray-900 truncate">${this.escapeHtml(chain.chain_name)}</h4>
                <span class="text-xs ${statusColor}">${statusIcon}</span>
            </div>
            <div class="space-y-1">
                <div class="flex justify-between items-center">
                    <span class="text-sm text-gray-600">Value:</span>
                    <span class="font-medium ${statusColor}">$${totalValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                <div class="flex justify-between items-center">
                    <span class="text-sm text-gray-600">Wallets:</span>
                    <span class="text-sm text-gray-700">${chain.wallet_count}</span>
                </div>
                <div class="flex justify-between items-center">
                    <span class="text-sm text-gray-600">Tokens:</span>
                    <span class="text-sm text-gray-700">${chain.token_count}</span>
                </div>
            </div>
        `;

        return card;
    }

    updateDetailedWalletView() {
        if (!this.detailedBalances) return;

        const detailsContainer = document.getElementById('walletDetailsList');
        detailsContainer.innerHTML = '';

        this.detailedBalances.forEach(chain => {
            const chainSection = this.createDetailedChainSection(chain);
            detailsContainer.appendChild(chainSection);
        });
    }

    createDetailedChainSection(chain) {
        const section = document.createElement('div');
        section.className = 'bg-gray-50 rounded-lg p-4 border';

        let walletsHtml = '';
        let totalChainValue = 0;

        chain.wallets.forEach(wallet => {
            if (wallet.tokens && wallet.tokens.length > 0) {
                totalChainValue += wallet.total_usd;
                
                const tokensHtml = wallet.tokens.map(token => `
                    <div class="flex justify-between items-center py-1">
                        <div class="flex items-center">
                            <span class="text-sm font-mono text-gray-600">${this.escapeHtml(token.symbol || token.denom)}</span>
                            <span class="ml-2 text-xs text-gray-400">${token.last_updated ? new Date(token.last_updated).toLocaleTimeString() : ''}</span>
                        </div>
                        <div class="text-right">
                            <div class="text-sm font-medium">${token.balance.toLocaleString('en-US', {maximumFractionDigits: 6})}</div>
                            <div class="text-xs text-gray-500">$${token.balance_usd.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                        </div>
                    </div>
                `).join('');

                walletsHtml += `
                    <div class="bg-white rounded p-3 border-l-4 ${wallet.total_usd < 10 ? 'border-red-400' : wallet.total_usd < 50 ? 'border-yellow-400' : 'border-green-400'}">
                        <div class="flex justify-between items-center mb-2">
                            <div>
                                <div class="text-sm font-medium text-gray-900">${wallet.address_type.charAt(0).toUpperCase() + wallet.address_type.slice(1)} Wallet</div>
                                <div class="text-xs font-mono text-gray-500">${wallet.address.substring(0, 16)}...${wallet.address.substring(wallet.address.length - 8)}</div>
                            </div>
                            <div class="text-right">
                                <div class="text-sm font-bold ${wallet.total_usd < 10 ? 'text-red-600' : wallet.total_usd < 50 ? 'text-yellow-600' : 'text-green-600'}">
                                    $${wallet.total_usd.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                                </div>
                                <div class="text-xs text-gray-500">${wallet.tokens.length} tokens</div>
                            </div>
                        </div>
                        <div class="space-y-1">
                            ${tokensHtml}
                        </div>
                    </div>
                `;
            }
        });

        section.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <h4 class="font-semibold text-gray-900">${this.escapeHtml(chain.chain_name)}</h4>
                <span class="font-bold text-blue-600">$${totalChainValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            </div>
            <div class="space-y-2">
                ${walletsHtml}
            </div>
        `;

        return section;
    }

    handleWalletUpdate(data) {
        // Handle real-time wallet balance updates via WebSocket
        console.log('Wallet balance updated:', data);
        
        if (data.type === 'balance_update') {
            // Refresh wallet data
            this.loadWalletBalances();
            
            // Show toast notification
            const changeType = data.data.change_amount > 0 ? 'increased' : 'decreased';
            const changeAmount = Math.abs(data.data.change_amount);
            this.showToast(
                'Balance Updated',
                `${data.data.chain_name} balance ${changeType} by ${changeAmount.toLocaleString('en-US', {maximumFractionDigits: 6})}`,
                'info'
            );
        }
        
        if (data.type === 'wallet_alert') {
            // Show low balance alert
            this.showToast(
                'Low Balance Alert',
                data.data.message,
                data.data.severity
            );
        }
    }

    handleWalletAlert(data) {
        // Handle wallet alert notifications from WebSocket
        console.log('Wallet alert received:', data);
        
        // Show toast notification for low balance alerts
        this.showToast(
            'Low Balance Alert',
            data.message,
            data.severity
        );
        
        // Refresh wallet data to reflect current state
        this.loadWalletBalances();
        
        // Optional: Add visual indicator to the affected wallet
        if (data.chain_id) {
            const chainCard = document.querySelector(`[data-chain-id="${data.chain_id}"]`);
            if (chainCard) {
                chainCard.classList.add('border-yellow-400');
                setTimeout(() => {
                    chainCard.classList.remove('border-yellow-400');
                }, 5000);
            }
        }
    }

    // UI Helper Methods
    showLoading() {
        document.getElementById('chainLoading').classList.remove('hidden');
        document.getElementById('workerLoading').classList.remove('hidden');
        document.getElementById('walletLoading').classList.remove('hidden');
    }

    hideLoading() {
        document.getElementById('chainLoading').classList.add('hidden');
        document.getElementById('workerLoading').classList.add('hidden');
    }

    hideLoadingScreen() {
        document.getElementById('loadingScreen').classList.add('hidden');
        document.getElementById('mainContent').classList.remove('hidden');
    }

    updateConnectionStatus(connected, text = null) {
        const statusElement = document.getElementById('connectionStatus');
        const textElement = document.getElementById('connectionText');
        const wsStatusElement = document.getElementById('wsStatus');

        if (connected) {
            statusElement.className = 'w-3 h-3 rounded-full bg-green-500 pulse-green';
            textElement.textContent = text || 'Connected';
            textElement.className = 'text-sm text-green-600';
            wsStatusElement.textContent = 'Connected';
            wsStatusElement.className = 'font-medium text-green-600';
        } else {
            statusElement.className = 'w-3 h-3 rounded-full bg-red-500';
            textElement.textContent = text || 'Disconnected';
            textElement.className = 'text-sm text-red-600';
            wsStatusElement.textContent = 'Disconnected';
            wsStatusElement.className = 'font-medium text-red-600';
        }
    }

    showToast(title, message, severity = 'info') {
        const toast = document.getElementById('alertToast');
        const toastTitle = document.getElementById('toastTitle');
        const toastMessage = document.getElementById('toastMessage');
        const toastIcon = document.getElementById('toastIcon');

        // Set content
        toastTitle.textContent = title;
        toastMessage.textContent = message;

        // Set icon and colors based on severity
        const severityConfig = {
            'critical': { icon: '🚨', borderColor: 'border-red-400' },
            'warning': { icon: '⚠️', borderColor: 'border-yellow-400' },
            'info': { icon: 'ℹ️', borderColor: 'border-blue-400' }
        };

        const config = severityConfig[severity] || severityConfig['info'];
        toastIcon.textContent = config.icon;
        
        // Reset border color classes
        toast.classList.remove('border-red-400', 'border-yellow-400', 'border-blue-400');
        toast.classList.add(config.borderColor);

        // Show toast
        toast.style.transform = 'translateY(0)';

        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideToast();
        }, 5000);
    }

    hideToast() {
        const toast = document.getElementById('alertToast');
        toast.style.transform = 'translateY(100%)';
    }

    showError(message) {
        this.showToast('Error', message, 'critical');
    }

    // Utility Methods
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getStatusClasses(status) {
        switch (status) {
            case 'active': return 'bg-green-100 text-green-800';
            case 'warning': return 'bg-yellow-100 text-yellow-800';
            case 'error': return 'bg-red-100 text-red-800';
            default: return 'bg-gray-100 text-gray-800';
        }
    }

    getStatusText(status) {
        switch (status) {
            case 'active': return 'Active';
            case 'warning': return 'Warning';
            case 'error': return 'Error';
            default: return 'Unknown';
        }
    }

    getAlertBorderClass(severity) {
        switch (severity) {
            case 'critical': return 'bg-red-50 border-red-400';
            case 'warning': return 'bg-yellow-50 border-yellow-400';
            default: return 'bg-blue-50 border-blue-400';
        }
    }

    getAlertTextClass(severity) {
        switch (severity) {
            case 'critical': return 'text-red-900';
            case 'warning': return 'text-yellow-900';
            default: return 'text-blue-900';
        }
    }

    getAlertDescClass(severity) {
        switch (severity) {
            case 'critical': return 'text-red-700';
            case 'warning': return 'text-yellow-700';
            default: return 'text-blue-700';
        }
    }

    getAlertBadgeClass(severity) {
        switch (severity) {
            case 'critical': return 'bg-red-100 text-red-800';
            case 'warning': return 'bg-yellow-100 text-yellow-800';
            default: return 'bg-blue-100 text-blue-800';
        }
    }
}

// Global functions for HTML onclick handlers
function toggleWalletDetails() {
    const detailsSection = document.getElementById('walletDetailsSection');
    const toggleText = document.getElementById('walletToggleText');
    const toggleIcon = document.getElementById('walletToggleIcon');
    
    if (detailsSection.classList.contains('hidden')) {
        detailsSection.classList.remove('hidden');
        toggleText.textContent = 'Hide Details';
        toggleIcon.textContent = '▲';
        
        // Load detailed view if dashboard instance is available
        if (window.dashboardInstance) {
            window.dashboardInstance.updateDetailedWalletView();
        }
    } else {
        detailsSection.classList.add('hidden');
        toggleText.textContent = 'Show Details';
        toggleIcon.textContent = '▼';
    }
}

// Initialize dashboard when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.dashboardInstance = new IBCDashboard();
});

// Security: Clear sensitive data on page unload
window.addEventListener('beforeunload', () => {
    // Clear any sensitive form data
    const sensitiveInputs = document.querySelectorAll('input[type="password"]');
    sensitiveInputs.forEach(input => {
        input.value = '';
    });
});

// Prevent context menu on secure content
document.addEventListener('contextmenu', (e) => {
    if (e.target.classList.contains('secure-content') || 
        e.target.closest('.secure-content')) {
        e.preventDefault();
    }
});

// Disable F12 and common developer tools shortcuts in production
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F12' || 
            (e.ctrlKey && e.shiftKey && e.key === 'I') ||
            (e.ctrlKey && e.shiftKey && e.key === 'C') ||
            (e.ctrlKey && e.shiftKey && e.key === 'J') ||
            (e.ctrlKey && e.key === 'U')) {
            e.preventDefault();
        }
    });
}