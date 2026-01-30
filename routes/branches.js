const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST /api/branches/create-manager
// Creates a manager account for a store
router.post('/create-manager', async (req, res) => {
    const { store_id, email, password } = req.body;
    const owner_id = req.user.id;

    try {
        // Verify the store belongs to the owner
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, owner_id')
            .eq('id', store_id)
            .single();

        if (storeError || !store) {
            return res.status(404).json({ error: 'Store not found' });
        }

        if (store.owner_id !== owner_id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Create manager user account
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true, // Auto-confirm email
        });

        if (userError) throw userError;

        const userId = userData.user.id;

        // Update profile
        const { error: profileError } = await supabaseAdmin
            .from('profiles')
            .update({
                full_name: `Manager - ${store_id.substring(0, 8)}`,
                role: 'manager',
                created_by: owner_id,
            })
            .eq('id', userId);

        if (profileError) {
            console.error('Profile update error:', profileError);
        }

        // Add to store_members
        const { error: memberError } = await supabaseAdmin
            .from('store_members')
            .insert({
                store_id,
                user_id: userId,
                role: 'manager',
            });

        if (memberError) throw memberError;

        res.json({
            success: true,
            manager_id: userId,
            email: email
        });

    } catch (error) {
        console.error('Create manager error:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/branches/reset-credentials
// Reset manager credentials for a store
router.post('/reset-credentials', async (req, res) => {
    const { store_id, old_user_id, new_email, new_password } = req.body;
    const owner_id = req.user.id;

    try {
        // Verify the store belongs to the owner
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, owner_id')
            .eq('id', store_id)
            .single();

        if (storeError || !store) {
            return res.status(404).json({ error: 'Store not found' });
        }

        if (store.owner_id !== owner_id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Delete old user if provided
        if (old_user_id) {
            await supabaseAdmin.auth.admin.deleteUser(old_user_id);
            await supabaseAdmin
                .from('store_members')
                .delete()
                .eq('user_id', old_user_id);
        }

        // Create new manager
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.createUser({
            email: new_email,
            password: new_password,
            email_confirm: true,
        });

        if (userError) throw userError;

        const userId = userData.user.id;

        // Update profile
        await supabaseAdmin
            .from('profiles')
            .update({
                full_name: `Manager - ${store_id.substring(0, 8)}`,
                role: 'manager',
                created_by: owner_id,
            })
            .eq('id', userId);

        // Add to store_members
        await supabaseAdmin
            .from('store_members')
            .insert({
                store_id,
                user_id: userId,
                role: 'manager',
            });

        res.json({
            success: true,
            manager_id: userId,
            email: new_email
        });

    } catch (error) {
        console.error('Reset credentials error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
