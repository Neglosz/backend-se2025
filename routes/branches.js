const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

        // Validate email format
        const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(new_email)) {
            return res.status(400).json({ error: 'Invalid email format' });
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

        // 5. Delete store_settings
        await supabaseAdmin
            .from('store_settings')
            .delete()
            .eq('store_id', store_id);

        // 6. Delete products
        await supabaseAdmin
            .from('products')
            .delete()
            .eq('store_id', store_id);

        // 7. Delete order_items for orders in this store
        const { data: orders } = await supabaseAdmin
            .from('orders')
            .select('id')
            .eq('store_id', store_id);

        if (orders && orders.length > 0) {
            const orderIds = orders.map(o => o.id);
            await supabaseAdmin
                .from('order_items')
                .delete()
                .in('order_id', orderIds);
        }

        // 8. Delete orders
        await supabaseAdmin
            .from('orders')
            .delete()
            .eq('store_id', store_id);

        // 9. Finally, delete the store
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
