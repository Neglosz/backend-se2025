const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { encrypt, decrypt } = require('../utils/crypto');

const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

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

        // Validate email format
        const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
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

        if (memberError) {
            // Roll back the auth account we just created, otherwise a failed link leaves
            // an orphan user that blocks the email from being reused.
            try {
                await supabaseAdmin.auth.admin.deleteUser(userId);
            } catch (cleanupError) {
                console.error('Failed to roll back orphan manager account:', userId, cleanupError.message);
            }
            throw memberError;
        }

        // Store the credentials here rather than letting the client write them, so the
        // password is only ever encrypted with the server-side key.
        await supabaseAdmin
            .from('store_credentials')
            .delete()
            .eq('store_id', store_id);

        const { error: credError } = await supabaseAdmin
            .from('store_credentials')
            .insert({
                store_id,
                email,
                password_encrypted: encrypt(password),
            });

        if (credError) {
            // The manager account itself is usable; only the owner's "view password"
            // convenience is lost, so this must not fail the request.
            console.error('Failed to store manager credentials:', credError);
        }

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

        // Validate email format BEFORE removing the current manager. Doing it the other
        // way round left the store with no manager at all whenever the new address was
        // malformed, because the 400 fired after the old account was already deleted.
        const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(new_email)) {
            return res.status(400).json({ error: 'Invalid email format' });
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

        // AES-256-CBC with a server-side key. The old scheme XOR'd against a constant
        // that shipped inside the mobile bundle, so anyone with the app could recover
        // every stored password.
        const encryptedPassword = encrypt(new_password);

        await supabaseAdmin
            .from('store_credentials')
            .delete()
            .eq('store_id', store_id);

        await supabaseAdmin
            .from('store_credentials')
            .insert({
                store_id,
                email: new_email,
                password_encrypted: encryptedPassword,
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

// GET /api/branches/:storeId/credentials
// Returns the manager login for a store. Owner only — the password is decrypted here
// because the key lives on the server; the client must never hold it.
router.get('/:storeId/credentials', async (req, res) => {
    try {
        const { storeId } = req.params;
        const owner_id = req.user.id;

        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, owner_id')
            .eq('id', storeId)
            .single();

        if (storeError || !store) {
            return res.status(404).json({ error: 'Store not found' });
        }

        if (store.owner_id !== owner_id) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        const { data: cred } = await supabaseAdmin
            .from('store_credentials')
            .select('email, password_encrypted')
            .eq('store_id', storeId)
            .order('created_at', { ascending: false })
            .limit(1);

        const row = cred?.[0];
        if (!row) {
            return res.status(404).json({ error: 'No credentials stored for this store' });
        }

        res.json({
            success: true,
            data: {
                email: row.email,
                // null when the stored value predates the AES migration (old XOR rows)
                // or the key changed — the client shows a "reset password" hint instead.
                password: decrypt(row.password_encrypted)
            }
        });
    } catch (error) {
        console.error('Get credentials error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/upload-image', upload.single('image'), async (req, res) => {
    try {
        const { store_id } = req.body;
        const file = req.file;

        if (!store_id) return res.status(400).json({ error: 'Store ID is required' });
        if (!file) return res.status(400).json({ error: 'No image file uploaded' });

        const owner_id = req.user.id;
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, owner_id')
            .eq('id', store_id)
            .single();

        if (storeError || !store) {
            return res.status(404).json({ error: 'Store not found' });
        }

        if (store.owner_id !== owner_id) {
            const { data: member } = await supabaseAdmin
                .from('store_members')
                .select('id')
                .eq('store_id', store_id)
                .eq('user_id', owner_id)
                .single();
            if (!member) {
                return res.status(403).json({ error: 'Not authorized' });
            }
        }

        const fileExt = file.originalname.split('.').pop();
        const fileName = `${Date.now()}_${Math.round(Math.random() * 1000)}.${fileExt}`;
        const filePath = `${store_id}/${fileName}`;

        const { data: uploadData, error: uploadError } = await supabaseAdmin
            .storage
            .from('store_images')
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: true
            });
        if (uploadError) throw uploadError;

        const { data: urlData } = supabaseAdmin
            .storage
            .from('store_images')
            .getPublicUrl(filePath);

        const publicUrl = urlData.publicUrl;
        const { error: updateError } = await supabaseAdmin
            .from('stores')
            .update({ image_url: publicUrl })
            .eq('id', store_id);
        if (updateError) throw updateError;

        res.json({
            success: true,
            message: 'Image uploaded successfully',
            imageUrl: publicUrl
        });


    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/branches/delete
// Delete a store and all related data (owner only)
router.delete('/delete', async (req, res) => {
    const { store_id } = req.body;
    const owner_id = req.user.id;

    try {
        // Verify the store belongs to the owner
        const { data: store, error: storeError } = await supabaseAdmin
            .from('stores')
            .select('id, owner_id, name')
            .eq('id', store_id)
            .single();

        if (storeError || !store) {
            return res.status(404).json({ error: 'Store not found' });
        }

        if (store.owner_id !== owner_id) {
            return res.status(403).json({ error: 'Not authorized - only owner can delete' });
        }

        // 1. Get all manager accounts for this store
        const { data: members } = await supabaseAdmin
            .from('store_members')
            .select('user_id')
            .eq('store_id', store_id);

        // 2. Delete manager user accounts
        if (members && members.length > 0) {
            for (const member of members) {
                try {
                    await supabaseAdmin.auth.admin.deleteUser(member.user_id);
                } catch (e) {
                    console.log('Could not delete user:', member.user_id, e.message);
                }
            }
        }

        // 3. Delete store_members
        await supabaseAdmin
            .from('store_members')
            .delete()
            .eq('store_id', store_id);

        // 4. Delete store_credentials
        await supabaseAdmin
            .from('store_credentials')
            .delete()
            .eq('store_id', store_id);

        // 5. Delete ai_recommendations
        await supabaseAdmin
            .from('ai_recommendations')
            .delete()
            .eq('store_id', store_id);

        // 6. Delete notifications
        await supabaseAdmin
            .from('notifications')
            .delete()
            .eq('store_id', store_id);

        // 7. Delete backup_logs
        await supabaseAdmin
            .from('backup_logs')
            .delete()
            .eq('store_id', store_id);

        // 8. Delete account_transactions
        await supabaseAdmin
            .from('account_transactions')
            .delete()
            .eq('store_id', store_id);

        // 9. Get all orders for this store
        const { data: orders } = await supabaseAdmin
            .from('orders')
            .select('id')
            .eq('store_id', store_id);

        if (orders && orders.length > 0) {
            const orderIds = orders.map(o => o.id);

            // 10. Delete payments for these orders
            await supabaseAdmin
                .from('payments')
                .delete()
                .in('order_id', orderIds);

            // 11. Delete order_items for these orders
            await supabaseAdmin
                .from('order_items')
                .delete()
                .in('order_id', orderIds);

            // 12. Delete credit_accounts for these orders
            await supabaseAdmin
                .from('credit_accounts')
                .delete()
                .in('order_id', orderIds);
        }

        // 13. Delete orders
        await supabaseAdmin
            .from('orders')
            .delete()
            .eq('store_id', store_id);

        // 14. Get all products for this store
        // Include soft-deleted products: filtering them out here (and in step 20) left
        // their rows and their batches/transactions orphaned after the store was gone.
        const { data: products } = await supabaseAdmin
            .from('products')
            .select('id')
            .eq('store_id', store_id);

        if (products && products.length > 0) {
            const productIds = products.map(p => p.id);

            // 15. Delete inventory_transactions for these products
            await supabaseAdmin
                .from('inventory_transactions')
                .delete()
                .in('product_id', productIds);

            // 16. Delete product_batches for these products
            await supabaseAdmin
                .from('product_batches')
                .delete()
                .in('product_id', productIds);

            // 17. Get all promotions for this store to delete promotion_items
            const { data: promotions } = await supabaseAdmin
                .from('promotions')
                .select('id')
                .eq('store_id', store_id);

            if (promotions && promotions.length > 0) {
                const promoIds = promotions.map(p => p.id);
                await supabaseAdmin
                    .from('promotion_items')
                    .delete()
                    .in('promotion_id', promoIds);
            }
        }

        // 18. Delete promotions
        await supabaseAdmin
            .from('promotions')
            .delete()
            .eq('store_id', store_id);

        // 19. Delete customers_info
        await supabaseAdmin
            .from('customers_info')
            .delete()
            .eq('store_id', store_id);

        // 20. Delete products (soft-deleted ones included — the store is going away)
        await supabaseAdmin
            .from('products')
            .delete()
            .eq('store_id', store_id);

        // 21. Delete product_categories
        await supabaseAdmin
            .from('product_categories')
            .delete()
            .eq('store_id', store_id);

        // 22. Delete store_order_counters
        await supabaseAdmin
            .from('store_order_counters')
            .delete()
            .eq('store_id', store_id);

        // 23. Finally, delete the store
        const { error: deleteError } = await supabaseAdmin
            .from('stores')
            .delete()
            .eq('id', store_id);

        if (deleteError) throw deleteError;

        res.json({
            success: true,
            message: `Store "${store.name}" deleted successfully`
        });

    } catch (error) {
        console.error('Delete store error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
