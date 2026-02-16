const registerStoreSettingsRoutes = ({
    app,
    supabaseAdmin,
    encrypt,
    decrypt,
    promptpay,
    checkStoreAccess
}) => {
app.get('/api/stores/settings', async (req, res) => {
    try {
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id; // Now safe

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // Check Access & Role
        let role = 'member';
        const { data: store } = await supabaseAdmin.from('stores').select('*').eq('id', storeId).single();
        if (store && store.owner_id === userId) {
            role = 'owner';
        } else {
            const { data: member } = await supabaseAdmin.from('store_members').select('role').eq('store_id', storeId).eq('user_id', userId).single();
            if (member) role = member.role;
            else return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        // Decrypt PromptPay ID
        let realPromptPayId = decrypt(store.promptpay_id_enc);
        let displayPromptPayId = '';

        if (realPromptPayId) {
            if (role === 'owner') {
                displayPromptPayId = realPromptPayId; // Owner sees full number
            } else {
                // Manager sees masked number
                if (store.promptpay_type === 'phone' && realPromptPayId.length >= 10) {
                    displayPromptPayId = `${realPromptPayId.substring(0, 3)}-xxx-${realPromptPayId.substring(6)}`;
                } else if (store.promptpay_type === 'id_card' && realPromptPayId.length >= 13) {
                    displayPromptPayId = `x-xxxx-xxxxx-${realPromptPayId.substring(10)}`;
                } else {
                    displayPromptPayId = 'xxx-xxx-xxxx';
                }
            }
        }

        res.json({
            success: true,
            data: {
                promptpay_id: displayPromptPayId, // Send masked or full based on role
                promptpay_type: store.promptpay_type,
                promptpay_name: store.promptpay_name,
                role: role // Send role so frontend knows if editable
            }
        });

    } catch (error) {
        console.error('Get Store Settings Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update Store Settings (PromptPay) - OWNER ONLY
app.put('/api/stores/settings', async (req, res) => {
    try {
        const { promptpay_id, promptpay_type, promptpay_name } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // 1. Strict Owner Check
        const { data: store } = await supabaseAdmin.from('stores').select('owner_id').eq('id', storeId).single();

        if (!store || store.owner_id !== userId) {
            return res.status(403).json({ success: false, error: 'Only Store Owner can edit payment settings' });
        }

        // 2. Encrypt Data
        const encryptedId = encrypt(promptpay_id);

        // 3. Update DB
        const { error } = await supabaseAdmin
            .from('stores')
            .update({
                promptpay_id_enc: encryptedId,
                promptpay_type,
                promptpay_name
            })
            .eq('id', storeId);

        if (error) throw error;

        res.json({ success: true, message: 'Settings updated successfully' });

    } catch (error) {
        console.error('Update Store Settings Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate PromptPay Payload (For QR Generation)
app.post('/api/sales/qr-payload', async (req, res) => {
    try {
        const { amount } = req.body;
        const storeId = req.headers['x-store-id'];
        const userId = req.user.id;

        if (!storeId) return res.status(400).json({ success: false, error: 'Store ID required' });

        // Check Access (Manager can access this to receive money)
        if (!await checkStoreAccess(storeId, userId)) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        // Get Store PromptPay Info
        const { data: store } = await supabaseAdmin
            .from('stores')
            .select('promptpay_id_enc, promptpay_type')
            .eq('id', storeId)
            .single();

        if (!store || !store.promptpay_id_enc) {
            return res.status(400).json({ success: false, error: 'Store has not set up PromptPay yet' });
        }

        // Decrypt
        const realPromptPayId = decrypt(store.promptpay_id_enc);
        if (!realPromptPayId) {
            return res.status(500).json({ success: false, error: 'Decryption failed' });
        }

        // Generate Payload using 'promptpay-qr'
        const payload = promptpay(realPromptPayId, { amount: parseFloat(amount) });

        res.json({ success: true, payload });

    } catch (error) {
        console.error('Generate QR Payload Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
};

module.exports = { registerStoreSettingsRoutes };
